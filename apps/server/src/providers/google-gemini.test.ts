import { describe, expect, it } from "vitest";
import type { GeminiAcpClientLike, GeminiAcpNotification } from "../gemini/acp-client.js";
import { GoogleGeminiProvider } from "./google-gemini.js";

class FakeGeminiClient implements GeminiAcpClientLike {
  listeners = new Set<(notification: GeminiAcpNotification) => void>();
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  authMethods = [
    { id: "oauth-personal" },
    { id: "gemini-api-key" },
    { id: "vertex-ai" },
  ];
  promptChunkDelayMs = 0;
  closed = false;

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params });

    if (method === "initialize") {
      return { authMethods: this.authMethods } as T;
    }
    if (method === "authenticate") {
      return {} as T;
    }
    if (method === "session/new") {
      return { sessionId: "gemini-session-1" } as T;
    }
    if (method === "session/prompt") {
      const emitChunks = () => {
        this.emit({
          method: "session/update",
          params: {
            sessionId: "gemini-session-1",
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "private reasoning" },
            },
          },
        });
        this.emit({
          method: "session/update",
          params: {
            sessionId: "gemini-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Gemini subscription " },
            },
          },
        });
        this.emit({
          method: "session/update",
          params: {
            sessionId: "gemini-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "answer" },
            },
          },
        });
      };

      if (this.promptChunkDelayMs > 0) setTimeout(emitChunks, this.promptChunkDelayMs);
      else emitChunks();

      return {
        stopReason: "end_turn",
        _meta: {
          quota: {
            token_count: { input_tokens: 17, output_tokens: 9 },
          },
        },
      } as T;
    }
    throw new Error(`Unexpected Gemini ACP request: ${method}`);
  }

  onNotification(listener: (notification: GeminiAcpNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
  }

  private emit(notification: GeminiAcpNotification) {
    for (const listener of this.listeners) listener(notification);
  }
}

describe("GoogleGeminiProvider", () => {
  it("exposes stable Gemini CLI aliases without authenticating just to list models", async () => {
    const clients: FakeGeminiClient[] = [];
    const provider = new GoogleGeminiProvider(model => {
      expect(model).toBeUndefined();
      const client = new FakeGeminiClient();
      clients.push(client);
      return client;
    }, () => true);

    const models = await provider.listModels();

    expect(models.map(model => model.model)).toEqual(["auto", "pro", "flash", "flash-lite"]);
    expect(models[0]).toMatchObject({ provider: "google", source: "subscription", isDefault: true });
    expect(clients.flatMap(client => client.requests).some(request => request.method === "authenticate")).toBe(false);
    expect(clients.every(client => client.closed)).toBe(true);
  });

  it("reports an installed CLI as signed out when no cached Google OAuth exists", async () => {
    const provider = new GoogleGeminiProvider(() => new FakeGeminiClient(), () => false);

    const status = await provider.status();

    expect(status).toMatchObject({
      id: "google",
      available: true,
      connected: false,
      authMode: "oauth",
    });
    expect(status.message).toMatch(/run `gemini` once/i);
  });

  it("refuses API-key or Vertex-only ACP auth", async () => {
    const provider = new GoogleGeminiProvider(() => {
      const client = new FakeGeminiClient();
      client.authMethods = [{ id: "gemini-api-key" }, { id: "vertex-ai" }];
      return client;
    }, () => true);

    const status = await provider.status();
    expect(status.connected).toBe(false);
    await expect(provider.listModels()).rejects.toThrow(/does not expose Google-account OAuth/i);
  });

  it("selects oauth-personal, selects the requested CLI model, and streams only answer text", async () => {
    const clients: FakeGeminiClient[] = [];
    const models: Array<string | undefined> = [];
    const provider = new GoogleGeminiProvider(model => {
      models.push(model);
      const client = new FakeGeminiClient();
      clients.push(client);
      return client;
    }, () => true);
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    const response = await provider.generate({
      model: "pro",
      messages: [{ role: "user", content: "Compare the designs." }],
    }, event => events.push(event));

    expect(models).toEqual(["pro"]);
    expect(response).toMatchObject({
      provider: "google",
      model: "pro",
      content: "Gemini subscription answer",
    });

    const client = clients[0];
    const authenticate = client.requests.find(request => request.method === "authenticate");
    expect(authenticate?.params).toEqual({ methodId: "oauth-personal" });
    expect(client.requests.find(request => request.method === "session/new")?.params).toMatchObject({ mcpServers: [] });
    expect(events.filter(event => event.type === "text_delta").map(event => event.delta).join(""))
      .toBe("Gemini subscription answer");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(events).toContainEqual({ type: "usage", inputTokens: 17, outputTokens: 9 });
    expect(client.closed).toBe(true);
  });

  it("fails before ACP authentication when Gemini CLI has not been signed in interactively", async () => {
    let created = false;
    const provider = new GoogleGeminiProvider(() => {
      created = true;
      return new FakeGeminiClient();
    }, () => false);

    await expect(provider.generate({
      model: "auto",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow(/not signed in with a Google account/i);
    expect(created).toBe(false);
  });

  it("waits for ACP text chunks that arrive just after session/prompt resolves", async () => {
    const client = new FakeGeminiClient();
    client.promptChunkDelayMs = 75;
    const provider = new GoogleGeminiProvider(() => client, () => true);

    const response = await provider.generate({
      model: "flash",
      messages: [{ role: "user", content: "Answer after the RPC completes." }],
    });

    expect(response.content).toBe("Gemini subscription answer");
    expect(client.closed).toBe(true);
  });
});
