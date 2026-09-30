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
});
