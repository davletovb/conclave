import { describe, expect, it } from "vitest";
import type { CodexClientLike, CodexNotification } from "../codex/app-server-client.js";
import { OpenAICodexProvider } from "./openai-codex.js";

class FakeCodexClient implements CodexClientLike {
  listeners = new Set<(notification: CodexNotification) => void>();
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  account: Record<string, unknown> = { type: "chatgpt", email: "test@example.com", planType: "plus" };
  emitItemCompleted = true;

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params });

    if (method === "account/read") {
      return { account: this.account, requiresOpenaiAuth: true } as T;
    }
    if (method === "model/list") {
      return {
        data: [
          { model: "gpt-secondary", displayName: "Secondary", isDefault: false },
          { model: "gpt-default", displayName: "Default", isDefault: true },
        ],
      } as T;
    }
    if (method === "thread/start") {
      return { thread: { id: "thr-1" } } as T;
    }
    if (method === "turn/start") {
      queueMicrotask(() => {
        if (this.emitItemCompleted) {
          this.emit({
            method: "item/completed",
            params: {
              threadId: "thr-1",
              turnId: "turn-1",
              item: { type: "agentMessage", text: "Real subscription answer" },
            },
          });
        }
        this.emit({
          method: "turn/completed",
          params: {
            threadId: "thr-1",
            turn: {
              id: "turn-1",
              status: "completed",
              error: null,
              items: [{ type: "agentMessage", text: "Real subscription answer" }],
            },
          },
        });
      });
      return { turn: { id: "turn-1" } } as T;
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  onNotification(listener: (notification: CodexNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {}

  private emit(notification: CodexNotification) {
    for (const listener of this.listeners) listener(notification);
  }
}

describe("OpenAICodexProvider", () => {
  it("exposes ChatGPT subscription status and puts the default model first", async () => {
    const client = new FakeCodexClient();
    const provider = new OpenAICodexProvider(client);

    const status = await provider.status();
    const models = await provider.listModels();

    expect(status.connected).toBe(true);
    expect(status.authMode).toBe("chatgpt");
    expect(status.planType).toBe("plus");
    expect(models[0]).toMatchObject({ model: "gpt-default", isDefault: true, source: "subscription" });
  });

  it("refuses API-key auth so Conclave cannot silently fall back to API billing", async () => {
    const client = new FakeCodexClient();
    client.account = { type: "apiKey" };
    const provider = new OpenAICodexProvider(client);

    const status = await provider.status();
    expect(status.connected).toBe(false);
    expect(status.authMode).toBe("apiKey");
    await expect(provider.listModels()).rejects.toThrow(/subscription-only/i);
  });

  it("runs an ephemeral read-only Codex turn using the current text-input schema", async () => {
    const client = new FakeCodexClient();
    const provider = new OpenAICodexProvider(client);

    const response = await provider.generate({
      model: "gpt-default",
      messages: [{ role: "user", content: "Explain the tradeoff." }],
    });

    expect(response.content).toBe("Real subscription answer");
    const threadStart = client.requests.find(request => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      model: "gpt-default",
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const turnStart = client.requests.find(request => request.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: "thr-1",
      input: [{ type: "text", text: "USER:\nExplain the tradeoff.", text_elements: [] }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("can recover the final answer from turn/completed when item events are absent", async () => {
    const client = new FakeCodexClient();
    client.emitItemCompleted = false;
    const provider = new OpenAICodexProvider(client);

    const response = await provider.generate({
      model: "gpt-default",
      messages: [{ role: "user", content: "Explain the tradeoff." }],
    });

    expect(response.content).toBe("Real subscription answer");
  });
});
