import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { GeminiAcpClientLike, GeminiAcpNotification } from "../gemini/acp-client.js";
import { GoogleGeminiProvider } from "./google-gemini.js";

class FakeGeminiClient implements GeminiAcpClientLike {
  readonly workspaceDir = join(tmpdir(), "conclave-gemini-test-workspace");
  listeners = new Set<(notification: GeminiAcpNotification) => void>();
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  authMethods = [
    { id: "oauth-personal" },
    { id: "gemini-api-key" },
    { id: "vertex-ai" },
  ];
  sessionNewError: Error | null = null;
  promptChunkDelayMs = 0;
  holdPrompt = false;
  thoughtChunkCount = 3;
  closed = false;
  private promptReject: ((error: Error) => void) | null = null;

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params });

    if (method === "initialize") {
      return { authMethods: this.authMethods } as T;
    }
    if (method === "session/new") {
      if (this.sessionNewError) throw this.sessionNewError;
      return { sessionId: "gemini-session-1" } as T;
    }
    if (method === "session/prompt") {
      if (this.holdPrompt) {
        return new Promise<T>((_resolve, reject) => {
          this.promptReject = reject;
        });
      }

      const emitChunks = () => {
        for (let i = 0; i < this.thoughtChunkCount; i += 1) {
          this.emit({
            method: "session/update",
            params: {
              sessionId: "gemini-session-1",
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: `private reasoning ${i}` },
              },
            },
          });
        }
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

  async notify(method: string, params: Record<string, unknown> = {}) {
    this.notifications.push({ method, params });
    if (method === "session/cancel") {
      this.promptReject?.(new Error("Gemini prompt cancelled"));
      this.promptReject = null;
    }
  }

  onNotification(listener: (notification: GeminiAcpNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    this.promptReject?.(new Error("Gemini ACP client closed"));
    this.promptReject = null;
  }

  private emit(notification: GeminiAcpNotification) {
    for (const listener of this.listeners) listener(notification);
  }
}

async function waitForRequest(client: FakeGeminiClient, method: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (client.requests.some(request => request.method === method)) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${method}`);
}

describe("GoogleGeminiProvider", () => {
  it("exposes stable Gemini CLI aliases only after an OAuth-backed session opens", async () => {
    const clients: FakeGeminiClient[] = [];
    const provider = new GoogleGeminiProvider(model => {
      expect(model).toBeUndefined();
      const client = new FakeGeminiClient();
      clients.push(client);
      return client;
    });

    const models = await provider.listModels();

    expect(models.map(model => model.model)).toEqual(["auto", "pro", "flash", "flash-lite"]);
    expect(models[0]).toMatchObject({ provider: "google", source: "subscription", isDefault: true });
    const requests = clients.flatMap(client => client.requests);
    expect(requests.map(request => request.method)).toEqual(["initialize", "session/new"]);
    expect(requests.some(request => request.method === "authenticate")).toBe(false);
    expect(clients.every(client => client.closed)).toBe(true);
  });

  it("reports an installed CLI as signed out when the OAuth-forced session cannot open", async () => {
    let created = 0;
    const provider = new GoogleGeminiProvider(() => {
      created += 1;
      const client = new FakeGeminiClient();
      client.sessionNewError = new Error("Authentication required");
      return client;
    });

    const status = await provider.status();

    expect(status).toMatchObject({
      id: "google",
      available: true,
      connected: false,
      authMode: "oauth",
    });
    expect(status.message).toMatch(/run `gemini` in a terminal/i);
    await expect(provider.listModels()).rejects.toThrow(/authentication required/i);
    expect(created).toBe(2);
  });

  it("does not mistake a credential 'not found' error for a missing Gemini executable", async () => {
    const provider = new GoogleGeminiProvider(() => {
      const client = new FakeGeminiClient();
      client.sessionNewError = new Error("OAuth credentials not found");
      return client;
    });

    const status = await provider.status();

    expect(status).toMatchObject({
      id: "google",
      available: true,
      connected: false,
      authMode: "oauth",
    });
    expect(status.message).toMatch(/sign in with google/i);
  });

  it("refuses a Gemini CLI build that does not expose Google-account OAuth", async () => {
    const provider = new GoogleGeminiProvider(() => {
      const client = new FakeGeminiClient();
      client.authMethods = [{ id: "gemini-api-key" }, { id: "vertex-ai" }];
      return client;
    });

    const status = await provider.status();
    expect(status.connected).toBe(false);
    await expect(provider.listModels()).rejects.toThrow(/no Google-account OAuth method/i);
  });

  it("uses the isolated OAuth workspace and streams only answer text", async () => {
    const clients: FakeGeminiClient[] = [];
    const models: Array<string | undefined> = [];
    const provider = new GoogleGeminiProvider(model => {
      models.push(model);
      const client = new FakeGeminiClient();
      clients.push(client);
      return client;
    });
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
    expect(client.requests.some(request => request.method === "authenticate")).toBe(false);
    expect(client.requests.find(request => request.method === "session/new")?.params).toMatchObject({
      cwd: client.workspaceDir,
      mcpServers: [],
    });
    expect(events.filter(event => event.type === "text_delta").map(event => event.delta).join(""))
      .toBe("Gemini subscription answer");
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(events.filter(event => event.type === "status")).toHaveLength(1);
    expect(events).toContainEqual({ type: "usage", inputTokens: 17, outputTokens: 9 });
    expect(client.closed).toBe(true);
  });

  it("sends ACP session/cancel before closing an aborted in-flight prompt", async () => {
    const client = new FakeGeminiClient();
    client.holdPrompt = true;
    const provider = new GoogleGeminiProvider(() => client);
    const controller = new AbortController();

    const pending = provider.generate({
      model: "auto",
      messages: [{ role: "user", content: "Keep thinking." }],
      signal: controller.signal,
    });

    await waitForRequest(client, "session/prompt");
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(client.notifications).toContainEqual({
      method: "session/cancel",
      params: { sessionId: "gemini-session-1" },
    });
    expect(client.closed).toBe(true);
  });

  it("waits for ACP text chunks that arrive just after session/prompt resolves", async () => {
    const client = new FakeGeminiClient();
    client.promptChunkDelayMs = 75;
    const provider = new GoogleGeminiProvider(() => client);

    const response = await provider.generate({
      model: "flash",
      messages: [{ role: "user", content: "Answer after the RPC completes." }],
    });

    expect(response.content).toBe("Gemini subscription answer");
    expect(client.closed).toBe(true);
  });
});
