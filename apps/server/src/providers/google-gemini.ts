import { tmpdir } from "node:os";
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
  hasCachedGeminiOAuth,
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
    private readonly hasCachedOAuth: () => boolean = hasCachedGeminiOAuth,
  ) {}

  async status(): Promise<ProviderStatus> {
    const client = this.createClient();
    try {
      const init = await this.initialize(client);
      const authMethods = new Set((init.authMethods ?? []).map(method => method.id));
      if (!authMethods.has("oauth-personal")) {
        return {
          id: this.id,
          label: this.label,
          available: true,
          connected: false,
          message: "Gemini CLI is installed, but this build does not expose Google-account OAuth over ACP.",
        };
      }

      const cached = this.hasCachedOAuth();
      return {
        id: this.id,
        label: this.label,
        available: true,
        connected: cached,
        authMode: "oauth",
        message: cached
          ? "Using your cached Google-account sign-in through the official Gemini CLI ACP interface"
          : "Gemini CLI is installed. Run `gemini` once and choose Sign in with Google before using it in Conclave.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gemini CLI runtime unavailable";
      const unavailable = /ENOENT|not found|spawn gemini/i.test(message);
      return {
        id: this.id,
        label: this.label,
        available: !unavailable,
        connected: false,
        message,
      };
    } finally {
      client.close();
    }
  }

  async listModels(): Promise<ModelRef[]> {
    if (!this.hasCachedOAuth()) {
      throw new Error("Gemini CLI is not signed in with a Google account. Run `gemini` and choose Sign in with Google.");
    }

    const client = this.createClient();
    try {
      const init = await this.initialize(client);
      const authMethods = new Set((init.authMethods ?? []).map(method => method.id));
      if (!authMethods.has("oauth-personal")) {
        throw new Error("Gemini CLI ACP does not expose Google-account OAuth in this installation.");
      }
      return GEMINI_MODELS;
    } finally {
      client.close();
    }
  }

  async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    if (request.signal?.aborted) throw cancelledError();
    if (!this.hasCachedOAuth()) {
      throw new Error("Gemini CLI is not signed in with a Google account. Run `gemini`, choose Sign in with Google, then retry in Conclave.");
    }

    const client = this.createClient(request.model);
    const startedAt = Date.now();
    let unsubscribe = () => {};
    const onAbort = () => client.close();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.authenticateSubscription(client);
      if (request.signal?.aborted) throw cancelledError();

      let sessionId = "";
      let streamedText = "";

      unsubscribe = client.onNotification((notification: GeminiAcpNotification) => {
        if (notification.method !== "session/update") return;
        const params = notification.params ?? {};
        if (sessionId && params.sessionId && params.sessionId !== sessionId) return;

        const update = params.update as Record<string, unknown> | undefined;
        if (!update) return;

        if (update.sessionUpdate === "agent_thought_chunk") {
          // Never expose model chain-of-thought. A generic status signal is
          // sufficient to keep a long reasoning turn legible in the UI.
          emit?.({ type: "status", message: "Gemini is reasoning…" });
          return;
        }

        if (update.sessionUpdate !== "agent_message_chunk") return;
        const content = update.content as Record<string, unknown> | undefined;
        if (typeof content?.text !== "string") return;

        streamedText += content.text;
        emit?.({ type: "text_delta", delta: content.text });
      });

      // Run the ACP session in a neutral temporary directory rather than the
      // Conclave repository so Gemini cannot accidentally ingest project files
      // or workspace instructions even if its tool policy changes upstream.
      const session = await client.request<SessionNewResponse>("session/new", {
        cwd: tmpdir(),
        mcpServers: [],
      }, 30_000);
      sessionId = session.sessionId;
      if (request.signal?.aborted) throw cancelledError();

      const prompt = this.buildPrompt(request);
      const timeoutMs = Number(process.env.CONCLAVE_GEMINI_TURN_TIMEOUT_MS ?? 180_000);
      const completion = await client.request<PromptResponse>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      }, timeoutMs);
      if (request.signal?.aborted) throw cancelledError();

      // Some ACP agents resolve session/prompt before the final notification is
      // flushed. Give the message stream a short grace period, then require two
      // stable checks before treating it as complete.
      const firstChunkWaitMs = Number(process.env.CONCLAVE_GEMINI_FIRST_CHUNK_WAIT_MS ?? 2_000);
      const firstChunkDeadline = Date.now() + firstChunkWaitMs;
      while (!streamedText && Date.now() < firstChunkDeadline) {
        if (request.signal?.aborted) throw cancelledError();
        await sleep(50);
      }

      let lastLength = -1;
      let stableChecks = 0;
      while (stableChecks < 2) {
        if (request.signal?.aborted) throw cancelledError();
        await sleep(150);
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
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 15_000);
  }

  private async authenticateSubscription(client: GeminiAcpClientLike) {
    const init = await this.initialize(client);
    const authMethods = new Set((init.authMethods ?? []).map(method => method.id));
    if (!authMethods.has("oauth-personal")) {
      if (authMethods.has("gemini-api-key") || authMethods.has("vertex-ai")) {
        throw new Error("Gemini CLI has no Google-account OAuth method available. Conclave refuses API-key and Vertex billing; sign in to the official Gemini CLI with your Google account.");
      }
      throw new Error("Gemini CLI is installed but does not expose a supported Google-account OAuth method over ACP.");
    }

    await client.request("authenticate", {
      methodId: "oauth-personal",
    }, 15_000);
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
