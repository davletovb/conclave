import type {
  ModelRef,
  ProviderAdapter,
  ProviderEventSink,
  ProviderRequest,
  ProviderResponse,
  ProviderStatus,
} from "@conclave/core";
import {
  GeminiAcpClient,
  type GeminiAcpClientLike,
  type GeminiAcpNotification,
} from "../gemini/acp-client.js";

type InitializeResponse = {
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
};

type SessionNewResponse = { sessionId: string };
type PromptResponse = {
  stopReason?: string;
  _meta?: {
    quota?: {
      token_count?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
};

const OAUTH_METHOD_ID = "oauth-personal";
const GEMINI_MODELS: ModelRef[] = [
  {
    provider: "google",
    model: "auto",
    label: "Gemini Auto",
    source: "subscription",
    isDefault: true,
  },
  {
    provider: "google",
    model: "pro",
    label: "Gemini Pro",
    source: "subscription",
  },
  {
    provider: "google",
    model: "flash",
    label: "Gemini Flash",
    source: "subscription",
  },
  {
    provider: "google",
    model: "flash-lite",
    label: "Gemini Flash Lite",
    source: "subscription",
  },
];

const TEXT_ONLY_INSTRUCTIONS = [
  "You are responding inside Conclave, a multi-model reasoning interface.",
  "Answer the user's request directly as text.",
  "Do not use local files, terminal commands, browser tools, MCP tools, or take external side effects.",
  "Do not reveal hidden chain-of-thought; provide concise conclusions and useful reasoning summaries instead.",
].join(" ");

export type GeminiAcpClientFactory = (model?: string) => GeminiAcpClientLike;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function durationFromEnv(name: string, fallbackMs: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallbackMs;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallbackMs;
}

function cancelledError() {
  const error = new Error("Gemini ACP turn cancelled");
  error.name = "AbortError";
  return error;
}

export class GoogleGeminiProvider implements ProviderAdapter {
  readonly id = "google" as const;
  readonly label = "Google Gemini via Gemini CLI";

  constructor(
    private readonly createClient: GeminiAcpClientFactory = model => new GeminiAcpClient(model),
  ) {}

  async status(): Promise<ProviderStatus> {
    let client: GeminiAcpClientLike | undefined;
    try {
      client = this.createClient();
      await this.openOAuthSession(client, 8_000);
      return {
        id: this.id,
        label: this.label,
        available: true,
        connected: true,
        authMode: "oauth",
        message: "Using your existing Google-account sign-in through the official Gemini CLI ACP interface",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gemini CLI runtime unavailable";
      // If construction itself failed, the runtime could not even be launched
      // safely (TMPDIR permissions/full disk/etc.). A missing executable is the
      // normal async spawn failure. Neither should 500 the /providers route.
      const unavailable = !client || /spawn gemini\b.*\bENOENT\b/i.test(message);
      return {
        id: this.id,
        label: this.label,
        available: !unavailable,
        connected: false,
        authMode: unavailable ? undefined : "oauth",
        message: unavailable
          ? `Gemini CLI runtime unavailable. ${message}`
          : `Gemini CLI is installed but Google-account OAuth is not ready. Run \`gemini\` in a terminal, choose Sign in with Google, then restart Conclave. ${message}`,
      };
    } finally {
      client?.close();
    }
  }

  async listModels(): Promise<ModelRef[]> {
    let client: GeminiAcpClientLike | undefined;
    try {
      client = this.createClient();
      await this.openOAuthSession(client, 8_000);
      return GEMINI_MODELS;
    } finally {
      client?.close();
    }
  }

  async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    if (request.signal?.aborted) throw cancelledError();

    const client = this.createClient(request.model);
    const startedAt = Date.now();
    let unsubscribe = () => {};
    let sessionId = "";
    let aborting = false;

    const onAbort = () => {
      if (aborting) return;
      aborting = true;
      if (!sessionId) {
        client.close();
        return;
      }

      // ACP defines session/cancel as a notification. Flush it to Gemini before
      // closing the stdio transport so an in-flight model request gets a chance
      // to stop cooperatively; close() still has SIGTERM/SIGKILL fallback.
      void client.notify("session/cancel", { sessionId })
        .catch(() => {})
        .finally(() => client.close());
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const session = await this.openOAuthSession(client, 30_000);
      sessionId = session.sessionId;
      if (request.signal?.aborted) throw cancelledError();

      let streamedText = "";
      let lastReasoningStatusAt = 0;

      unsubscribe = client.onNotification((notification: GeminiAcpNotification) => {
        if (notification.method !== "session/update") return;
        const params = notification.params ?? {};
        if (sessionId && params.sessionId && params.sessionId !== sessionId) return;

        const update = params.update as Record<string, unknown> | undefined;
        if (!update) return;

        if (update.sessionUpdate === "agent_thought_chunk") {
          // Never expose model chain-of-thought. Emit at most one generic
          // heartbeat every five seconds so active long reasoning does not look
          // stalled without writing one durable event per thought token.
          const now = Date.now();
          if (now - lastReasoningStatusAt >= 5_000) {
            lastReasoningStatusAt = now;
            emit?.({ type: "status", message: "Gemini is reasoning…" });
          }
          return;
        }

        if (update.sessionUpdate !== "agent_message_chunk") return;
        const content = update.content as Record<string, unknown> | undefined;
        if (typeof content?.text !== "string") return;

        streamedText += content.text;
        emit?.({ type: "text_delta", delta: content.text });
      });

      const prompt = this.buildPrompt(request);
      const timeoutMs = Number(process.env.CONCLAVE_GEMINI_TURN_TIMEOUT_MS ?? 180_000);
      const completion = await client.request<PromptResponse>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      }, timeoutMs);
      if (request.signal?.aborted) throw cancelledError();

      // Some ACP agents resolve session/prompt before their final notification
      // has flushed. Wait briefly for a first chunk and then for two stable
      // samples, but cap the whole settling phase so a chatty/malformed agent
      // cannot keep generate() alive indefinitely after the RPC already ended.
      const firstChunkWaitMs = durationFromEnv("CONCLAVE_GEMINI_FIRST_CHUNK_WAIT_MS", 2_000);
      const firstChunkDeadline = Date.now() + firstChunkWaitMs;
      while (!streamedText && Date.now() < firstChunkDeadline) {
        if (request.signal?.aborted) throw cancelledError();
        await sleep(Math.min(50, Math.max(1, firstChunkDeadline - Date.now())));
      }

      const settleWindowMs = durationFromEnv("CONCLAVE_GEMINI_SETTLE_WINDOW_MS", 2_000);
      const settleDeadline = Date.now() + settleWindowMs;
      let lastLength = streamedText.length;
      let stableChecks = 0;
      while (stableChecks < 2 && Date.now() < settleDeadline) {
        if (request.signal?.aborted) throw cancelledError();
        await sleep(Math.min(150, Math.max(1, settleDeadline - Date.now())));
        if (streamedText.length === lastLength) {
          stableChecks += 1;
        } else {
          lastLength = streamedText.length;
          stableChecks = 0;
        }
      }

      const tokenCount = completion._meta?.quota?.token_count;
      if (tokenCount && (tokenCount.input_tokens !== undefined || tokenCount.output_tokens !== undefined)) {
        emit?.({
          type: "usage",
          inputTokens: tokenCount.input_tokens,
          outputTokens: tokenCount.output_tokens,
        });
      }

      const content = streamedText.trim();
      if (!content) {
        throw new Error(`Gemini completed without a text response${completion.stopReason ? ` (stopReason=${completion.stopReason})` : ""}`);
      }

      return {
        provider: this.id,
        model: request.model,
        content,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (request.signal?.aborted) throw cancelledError();
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      client.close();
    }
  }

  private async initialize(client: GeminiAcpClientLike) {
    return client.request<InitializeResponse>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "Conclave", version: "1" },
      // Omit fs/terminal capabilities entirely. In Gemini ACP, the presence of
      // `clientCapabilities.fs` is itself enough to install an ACP filesystem
      // service even if individual booleans are false.
      clientCapabilities: {},
    }, 15_000);
  }

  private async openOAuthSession(client: GeminiAcpClientLike, timeoutMs: number) {
    const init = await this.initialize(client);
    const authMethods = new Set((init.authMethods ?? []).map(method => method.id));
    if (!authMethods.has(OAUTH_METHOD_ID)) {
      if (authMethods.has("gemini-api-key") || authMethods.has("vertex-ai")) {
        throw new Error("Gemini CLI has no Google-account OAuth method available. Conclave refuses API-key and Vertex billing; install a Gemini CLI build that exposes Google-account OAuth.");
      }
      throw new Error("Gemini CLI is installed but does not expose a supported Google-account OAuth method over ACP.");
    }

    // The per-process trusted workspace forces security.auth.selectedType to
    // oauth-personal. session/new therefore validates the CLI's existing Google
    // sign-in without calling ACP authenticate(), which can start an interactive
    // OAuth flow. NO_BROWSER plus stdout/stderr auth-prompt detection make
    // stale/missing credentials fail closed instead of launching UI.
    return client.request<SessionNewResponse>("session/new", {
      cwd: client.workspaceDir,
      mcpServers: [],
    }, timeoutMs);
  }

  private buildPrompt(request: ProviderRequest) {
    const parts = [TEXT_ONLY_INSTRUCTIONS];
    if (request.system) parts.push(`SYSTEM CONTEXT:\n${request.system}`);
    for (const message of request.messages) {
      parts.push(`${message.role.toUpperCase()}:\n${message.content}`);
    }
    return parts.join("\n\n");
  }
}
