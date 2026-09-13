import { describe, expect, it } from "vitest";
import type { GrokAcpClientLike, GrokAcpNotification } from "../grok/acp-client.js";
import { XaiGrokProvider } from "./xai-grok.js";

class FakeGrokClient implements GrokAcpClientLike {
  listeners = new Set<(notification: GrokAcpNotification) => void>();
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  authMethods = [{ id: "cached_token" }];
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
      return { sessionId: "session-1" } as T;
    }
    if (method === "session/prompt") {
      this.emit({
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Real Grok " },
          },
        },
      });
      this.emit({
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "subscription answer" },
          },
        },
      });
      return { stopReason: "end_turn" } as T;
    }
    throw new Error(`Unexpected Grok ACP request: ${method}`);
  }

  onNotification(listener: (notification: GrokAcpNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
  }

  private emit(notification: GrokAcpNotification) {
    for (const listener of this.listeners) listener(notification);
  }
}

describe("XaiGrokProvider", () => {
  it("accepts cached OAuth subscription auth and exposes current Grok models", async () => {
    const clients: FakeGrokClient[] = [];
    const provider = new XaiGrokProvider(() => {
      const client = new FakeGrokClient();
      clients.push(client);
      return client;
    });

    const status = await provider.status();
    const models = await provider.listModels();

    expect(status).toMatchObject({ connected: true, authMode: "oauth" });
    expect(models.map(model => model.model)).toEqual(["grok-4.6", "grok-4.5"]);
    expect(models[0]).toMatchObject({ source: "subscription", isDefault: true });
    expect(clients.every(client => client.closed)).toBe(true);
  });

  it("refuses API-key-only auth rather than risking metered xAI billing", async () => {
    const provider = new XaiGrokProvider(() => {
      const client = new FakeGrokClient();
      client.authMethods = [{ id: "xai.api_key" }];
      return client;
    });

    const status = await provider.status();
    expect(status.connected).toBe(false);
    expect(status.message).toMatch(/refuses API-key billing/i);
    await expect(provider.listModels()).rejects.toThrow(/refuses API-key billing/i);
  });

  it("runs a model-selected ACP session and captures streamed agent text", async () => {
    const client = new FakeGrokClient();
    const provider = new XaiGrokProvider(() => client);

    const response = await provider.generate({
      model: "grok-4.6",
      messages: [{ role: "user", content: "Compare the designs." }],
    });

    expect(response.content).toBe("Real Grok subscription answer");

    const authenticate = client.requests.find(request => request.method === "authenticate");
    expect(authenticate?.params).toMatchObject({ methodId: "cached_token" });

    const sessionNew = client.requests.find(request => request.method === "session/new");
    expect(sessionNew?.params).toMatchObject({
      mcpServers: [],
      _meta: { modelId: "grok-4.6" },
    });

    const prompt = client.requests.find(request => request.method === "session/prompt");
    expect(prompt?.params).toMatchObject({ sessionId: "session-1" });
    expect(client.closed).toBe(true);
  });
});
