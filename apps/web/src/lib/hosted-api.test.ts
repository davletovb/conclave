import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

// Nothing is paired in these tests, so every real provider reports itself unavailable.
async function hosted(mock: boolean) {
  vi.resetModules();
  vi.stubEnv("VITE_CONCLAVE_MOCK", mock ? "1" : "");
  const { hostedFetch } = await import("./hosted-api");
  return hostedFetch;
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("the hosted app's provider catalogue", () => {
  it("does not offer the scripted mock provider or its models when the real providers are unavailable", async () => {
    const hostedFetch = await hosted(false);
    const providers = await (await hostedFetch("/providers")).json() as Array<{ id: string; connected: boolean }>;
    expect(providers.map(provider => provider.id)).toEqual(["openai", "anthropic", "xai", "google"]);
    expect(providers.every(provider => !provider.connected)).toBe(true);
    expect(await (await hostedFetch("/models")).json()).toEqual([]);
  });

  it("offers the mock only when the build asks for it, and labels it as a demo", async () => {
    const hostedFetch = await hosted(true);
    const providers = await (await hostedFetch("/providers")).json() as Array<{ id: string; label: string }>;
    expect(providers.find(provider => provider.id === "mock")?.label).toMatch(/demo/);
    const models = await (await hostedFetch("/models")).json() as Array<{ model: string }>;
    expect(models.map(model => model.model).sort()).toEqual(["mock-claude", "mock-gemini", "mock-gpt", "mock-grok"]);
  });
});

describe("keeping the hosted app's history", () => {
  const health = async (storage: unknown) => {
    vi.stubGlobal("navigator", { storage });
    const hostedFetch = await hosted(false);
    return (await hostedFetch("/health")).json();
  };

  it("asks the browser to keep it and reports the answer", async () => {
    let asked = 0;
    expect(await health({ persisted: async () => false, persist: async () => { asked++; return true; } })).toEqual({ ok: true, persistent: true });
    expect(asked).toBe(1);
  });

  it("says so when the browser will not promise, or cannot be asked", async () => {
    expect(await health({ persisted: async () => false, persist: async () => false })).toEqual({ ok: true, persistent: false });
    expect(await health(undefined)).toEqual({ ok: true, persistent: false });
    expect(await health({ persisted: async () => { throw new Error("blocked"); } })).toEqual({ ok: true, persistent: false });
  });

  it("does not ask again when it is already granted", async () => {
    let asked = 0;
    expect(await health({ persisted: async () => true, persist: async () => { asked++; return true; } })).toEqual({ ok: true, persistent: true });
    expect(asked).toBe(0);
  });
});

