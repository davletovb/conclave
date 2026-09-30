import { describe, expect, it } from "vitest";
import { SeatlineProvider } from "./seatline-provider";
import type { SeatlineClient } from "./companion";

function companion(signIn?: string) {
  const calls: Array<{ provider: string; method: string; params: unknown }> = [];
  const client: SeatlineClient = {
    async request(provider, method, params, emit) {
      calls.push({ provider, method, params });
      if (method === "status") emit({ type: "status", status: {
        availability: "available", authentication: "authenticated", sign_in: signIn, models: [],
      } });
      if (method === "send") emit({ type: "delta", text: "Shared subscription response" });
    },
  };
  return { client, calls };
}

describe("Conclave subscription use through Seatline", () => {
  it("offers the real provider default when a CLI has no model catalogue", async () => {
    const { client, calls } = companion("subscription");
    const provider = new SeatlineProvider("openai", "OpenAI Codex", "codex", client);
    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ provider: "openai", source: "subscription", isDefault: true });
    expect(await provider.generate({ model: models[0].model, messages: [{ role: "user", content: "Hello" }] }))
      .toMatchObject({ provider: "openai", content: "Shared subscription response" });
    expect(calls.find(call => call.method === "send")).toMatchObject({ provider: "codex", params: {
      model: null, tools: "none", session: "ephemeral", check_sign_in: true,
    } });
  });

  it.each(["api_key", "unknown", undefined])("refuses %s authentication before a paid provider turn", async signIn => {
    const { client, calls } = companion(signIn);
    const provider = new SeatlineProvider("openai", "OpenAI Codex", "codex", client);
    expect(await provider.listModels()).toEqual([]);
    await expect(provider.generate({ model: "any", messages: [{ role: "user", content: "Hello" }] })).rejects.toThrow("verified subscription");
    expect(calls.some(call => call.method === "send")).toBe(false);
  });

  it("accepts the Google cloud account mode only for Google", async () => {
    const { client } = companion("cloud");
    const google = new SeatlineProvider("google", "Google Gemini", "gemini", client);
    const openai = new SeatlineProvider("openai", "OpenAI Codex", "codex", client);
    expect(await google.status()).toMatchObject({ connected: true });
    expect(await openai.status()).toMatchObject({ connected: false });
  });

  it("asks for provider status once for several steps of a run, and again once it is stale or unusable", async () => {
    const { client, calls } = companion("subscription");
    const provider = new SeatlineProvider("openai", "OpenAI Codex", "codex", client);
    const ask = () => provider.generate({ model: "any", messages: [{ role: "user", content: "Hello" }] });
    await Promise.all([ask(), ask(), ask()]);
    await ask();
    expect(calls.filter(call => call.method === "status")).toHaveLength(1);
    expect(calls.filter(call => call.method === "send")).toHaveLength(4);
  });

  it("checks again rather than trusting an earlier answer that said the provider was unusable", async () => {
    let signIn: string | undefined = "api_key";
    const calls: string[] = [];
    const client: SeatlineClient = {
      async request(_provider, method, _params, emit) {
        calls.push(method);
        if (method === "status") emit({ type: "status", status: { availability: "available", authentication: "authenticated", sign_in: signIn, models: [] } });
        if (method === "send") emit({ type: "delta", text: "ok" });
      },
    };
    const provider = new SeatlineProvider("openai", "OpenAI Codex", "codex", client);
    await expect(provider.generate({ model: "any", messages: [{ role: "user", content: "Hi" }] })).rejects.toThrow("verified subscription");
    signIn = "subscription"; // the user signed in
    await expect(provider.generate({ model: "any", messages: [{ role: "user", content: "Hi" }] })).resolves.toMatchObject({ content: "ok" });
    expect(calls.filter(method => method === "status")).toHaveLength(3);
  });

  it("does not remember a failed status request", async () => {
    let attempts = 0;
    const client: SeatlineClient = {
      async request(_provider, method, _params, emit) {
        if (method === "status" && ++attempts === 1) throw new Error("companion offline");
        if (method === "status") emit({ type: "status", status: { availability: "available", authentication: "authenticated", sign_in: "subscription", models: [] } });
      },
    };
    const provider = new SeatlineProvider("openai", "OpenAI Codex", "codex", client);
    expect(await provider.status()).toMatchObject({ connected: false, message: "companion offline" });
    expect(await provider.status()).toMatchObject({ connected: true });
  });

  it("turns a queued notice into run activity, so a step waiting for the companion is not counted as stalled", async () => {
    const client: SeatlineClient = {
      async request(_provider, method, _params, emit) {
        if (method === "status") emit({ type: "status", status: { availability: "available", authentication: "authenticated", sign_in: "subscription", models: [] } });
        if (method === "send") { emit({ type: "queued" }); emit({ type: "delta", text: "done" }); }
      },
    };
    const provider = new SeatlineProvider("openai", "OpenAI Codex", "codex", client);
    const events: unknown[] = [];
    await provider.generate({ model: "any", messages: [{ role: "user", content: "Hi" }] }, event => events.push(event));
    expect(events).toContainEqual({ type: "status", message: expect.stringContaining("Waiting for your Seatline companion") });
  });
});

