import type {
  ModelRef,
  ProviderAdapter,
  ProviderEventSink,
  ProviderRequest,
  ProviderResponse,
  ProviderStatus,
} from "@conclave/core";
import {
  GrokAcpClient,
  type GrokAcpClientLike,
  type GrokAcpNotification,
} from "../grok/acp-client.js";

type InitializeResponse = {
  authMethods?: Array<{ id: string; name?: string; description?: string }>;
};

type SessionNewResponse = { sessionId: string };
type PromptResponse = { stopReason?: string };

const GROK_MODELS: ModelRef[] = [
  {
    provider: "xai",
    model: "grok-4.6",
    label: "Grok 4.6",
    source: "subscription",
    isDefault: true,
  },
  {
    provider: "xai",
    model: "grok-4.5",
    label: "Grok 4.5",
    source: "subscription",
  },
];

const TEXT_ONLY_INSTRUCTIONS = [
  "You are responding inside Conclave, a multi-model reasoning interface.",
  "Answer the user's request directly as text.",
  "Do not use local files, terminal commands, MCP tools, or take external side effects.",
  "Do not reveal hidden chain-of-thought; provide concise conclusions and useful reasoning summaries instead.",
].join(" ");

export type GrokAcpClientFactory = () => GrokAcpClientLike;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cancelledError() {
  const error = new Error("Grok ACP turn cancelled");
  error.name = "AbortError";
  return error;
}

export class XaiGrokProvider implements ProviderAdapter {
  readonly id = "xai" as const;
  readonly label = "xAI via Grok Build";

  constructor(private readonly createClient: GrokAcpClientFactory = () => new GrokAcpClient()) {}

  async status(): Promise<ProviderStatus> {
    const client = this.createClient();
    try {
      await this.authenticateSubscription(client);
      return {
        id: this.id,
        label: this.label,
        available: true,
        connected: true,
        authMode: "oauth",
        message: "Using your signed-in Grok subscription through Grok Build ACP",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Grok Build runtime unavailable";
      const unavailable = /ENOENT|not found|spawn grok/i.test(message);
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
    const client = this.createClient();
    try {
      await this.authenticateSubscription(client);
      return GROK_MODELS;
    } finally {
      client.close();
    }
  }

  async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    if (request.signal?.aborted) throw cancelledError();
    const client = this.createClient();
    const startedAt = Date.now();
    let unsubscribe = () => {};
    const onAbort = () => client.close();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await this.authenticateSubscription(client);
      if (request.signal?.aborted) throw cancelledError();

      let sessionId = "";
      let streamedText = "";

      unsubscribe = client.onNotification((notification: GrokAcpNotification) => {
        if (notification.method !== "session/update") return;
        const params = notification.params ?? {};
        if (sessionId && params.sessionId && params.sessionId !== sessionId) return;

        const update = params.update as Record<string, unknown> | undefined;
        if (update?.sessionUpdate !== "agent_message_chunk") return;
        const content = update.content as Record<string, unknown> | undefined;
        if (typeof content?.text !== "string") return;

        streamedText += content.text;
        emit?.({ type: "text_delta", delta: content.text });
      });

      const session = await client.request<SessionNewResponse>("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { modelId: request.model },
      }, 30_000);
      sessionId = session.sessionId;
      if (request.signal?.aborted) throw cancelledError();

      const prompt = this.buildPrompt(request);
      const timeoutMs = Number(process.env.CONCLAVE_GROK_TURN_TIMEOUT_MS ?? 180_000);
      const completion = await client.request<PromptResponse>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      }, timeoutMs);
      if (request.signal?.aborted) throw cancelledError();

      const firstChunkWaitMs = Number(process.env.CONCLAVE_GROK_FIRST_CHUNK_WAIT_MS ?? 2_000);
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

      const content = streamedText.trim();
      if (!content) {
        throw new Error(`Grok completed without a text response${completion.stopReason ? ` (stopReason=${completion.stopReason})` : ""}`);
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

  private async authenticateSubscription(client: GrokAcpClientLike) {
    const init = await client.request<InitializeResponse>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 15_000);

    const authMethods = new Set((init.authMethods ?? []).map(method => method.id));
    if (!authMethods.has("cached_token")) {
      if (authMethods.has("xai.api_key")) {
        throw new Error("Grok Build has no cached subscription login. Conclave refuses API-key billing; run `grok login` and sign in with your Grok/X account.");
      }
      throw new Error("Grok Build is installed but not signed in. Run `grok login` and authenticate with your Grok/X subscription.");
    }

    await client.request("authenticate", {
      methodId: "cached_token",
      _meta: { headless: true },
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
