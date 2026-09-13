import { describe, expect, it } from "vitest";
import type { ProviderStreamEvent } from "@conclave/core";
import type { CodexClientLike, CodexNotification } from "../codex/app-server-client.js";
import { OpenAICodexProvider } from "./openai-codex.js";

class FakeCodexClient implements CodexClientLike {
  listeners = new Set<(notification: CodexNotification) => void>();
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  account: Record<string, unknown> = { type: "chatgpt", email: "test@example.com", planType: "plus" };
  emitItemCompleted = true;
  emitUsage = false;
  holdTurn = false;
  holdTurnStart = false;
  releaseTurnStart: (() => void) | null = null;

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params });

    if (method === "account/read") {
      return { account: this.account, requiresOpenaiAuth: true } as T;
    }
    if (method === "account/rateLimits/read") {
      return {
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1_800_100_000 },
          rateLimitReachedType: null,
        },
      } as T;
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
    if (method === "turn/interrupt") {
      return {} as T;
    }
    if (method === "turn/start") {
      if (this.holdTurnStart) {
        await new Promise<void>(resolve => { this.releaseTurnStart = resolve; });
      }
      if (!this.holdTurn) {
        queueMicrotask(() => {
          if (this.emitUsage) {
            this.emit({
              method: "thread/tokenUsage/updated",
              params: {
                threadId: "thr-1",
                tokenUsage: { total: { inputTokens: 123, outputTokens: 45 } },
              },
            });
          }
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
      }
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

async function waitForRequest(client: FakeCodexClient, method: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (client.requests.some(request => request.method === method)) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`${method} was not requested`);
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

  it("exposes the structured ChatGPT subscription limit windows from Codex", async () => {
    const client = new FakeCodexClient();
    const provider = new OpenAICodexProvider(client);

    const limits = await provider.limits();

    expect(limits).toMatchObject({
      provider: "openai",
      available: true,
      primary: { usedPercent: 42, windowDurationMins: 300 },
      secondary: { usedPercent: 17, windowDurationMins: 10080 },
    });
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

  it("forwards Codex token-usage notifications", async () => {
    const client = new FakeCodexClient();
    client.emitUsage = true;
    const provider = new OpenAICodexProvider(client);
    const events: ProviderStreamEvent[] = [];

    await provider.generate({
      model: "gpt-default",
      messages: [{ role: "user", content: "Count this." }],
    }, event => events.push(event));

    expect(events).toContainEqual({ type: "usage", inputTokens: 123, outputTokens: 45 });
  });

  it("interrupts the active Codex turn when the run is cancelled", async () => {
    const client = new FakeCodexClient();
    client.holdTurn = true;
    const provider = new OpenAICodexProvider(client);
    const controller = new AbortController();
    const promise = provider.generate({
      model: "gpt-default",
      messages: [{ role: "user", content: "Keep thinking." }],
      signal: controller.signal,
    });

    await waitForRequest(client, "turn/start");
    controller.abort();
    await expect(promise).rejects.toThrow(/cancel/i);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(client.requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thr-1", turnId: "turn-1" },
    });
  });

  it("handles cancellation safely while turn/start is still pending", async () => {
    const client = new FakeCodexClient();
    client.holdTurn = true;
    client.holdTurnStart = true;
    const provider = new OpenAICodexProvider(client);
    const controller = new AbortController();
    const promise = provider.generate({
      model: "gpt-default",
      messages: [{ role: "user", content: "Cancel during startup." }],
      signal: controller.signal,
    });

    await waitForRequest(client, "turn/start");
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 0));
    client.releaseTurnStart?.();

    await expect(promise).rejects.toThrow(/cancel/i);
    expect(client.requests.some(request => request.method === "turn/interrupt")).toBe(true);
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
