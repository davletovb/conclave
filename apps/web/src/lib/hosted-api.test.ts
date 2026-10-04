import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";

// Nothing is paired in these tests, so every real provider reports itself unavailable.
async function hosted(mock: boolean) {
  vi.resetModules();
  vi.stubEnv("VITE_CONCLAVE_MOCK", mock ? "1" : "");
  const { hostedFetch } = await import("./hosted-api");
  return hostedFetch;
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.doUnmock("./companion"); });

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


describe("the app's own readiness controls", () => {
  type Request = { provider: string; method: string; params: unknown };
  /** The hosted API over a companion that answers for every provider, and the requests it saw. */
  async function withCompanion(options: { legacy?: boolean } = {}) {
    const seen: Request[] = [];
    vi.resetModules(); vi.stubEnv("VITE_CONCLAVE_MOCK", "");
    vi.doMock("./companion", async () => {
      const actual = await vi.importActual<typeof import("./companion")>("./companion");
      class SeatlineClient {
        async request(provider: string, method: string, params: unknown, emit: (event: any) => void) {
          seen.push({ provider, method, params });
          if (options.legacy && ["readiness", "prepare"].includes(method)) throw new actual.SeatlineFailure("INVALID_REQUEST");
          if (["status", "readiness", "prepare"].includes(method)) emit({ type: "status", status: { availability: "available", authentication: "authenticated", sign_in: "subscription", models: [] } });
        }
      }
      return { ...actual, SeatlineClient, companionLink: { generation: () => 0, congested: () => false } };
    });
    const { hostedFetch } = await import("./hosted-api");
    const post = (providers: unknown) => hostedFetch("/providers/prepare", { method: "POST", body: JSON.stringify({ providers }) });
    return { hostedFetch, post, seen };
  }

  it("prepares only the providers it is told a run is likely to use, with no prompt", async () => {
    const { post, seen } = await withCompanion();
    const response = await post(["openai", "xai"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [{ id: "openai", outcome: "prepared" }, { id: "xai", outcome: "prepared" }] });
    expect(seen).toEqual([
      { provider: "codex", method: "prepare", params: { mode: "cached", max_age_ms: 30000 } },
      { provider: "grok", method: "prepare", params: { mode: "cached", max_age_ms: 30000 } },
    ]);
  });

  it("ignores providers it does not know, refuses a malformed request, and never fails because a provider could not be prepared", async () => {
    const { post, seen } = await withCompanion();
    expect(await (await post(["mystery"])).json()).toEqual({ providers: [] });
    expect(seen).toEqual([]);
    for (const bad of ["openai", [1], ["a", "b", "c", "d", "e"], undefined]) expect((await post(bad)).status).toBe(400);
    const old = await withCompanion({ legacy: true });
    expect(await (await old.post(["openai"])).json()).toEqual({ providers: [{ id: "openai", outcome: "skipped" }] });
    // Nothing paired at all: the real companion cannot be reached, and that is a skipped preparation, not an error.
    const unpaired = await hosted(false);
    vi.doUnmock("./companion");
    const response = await unpaired("/providers/prepare", { method: "POST", body: JSON.stringify({ providers: ["openai"] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [{ id: "openai", outcome: "skipped" }] });
  });

  it("asks for a new check, once for each provider, when the user retries; ordinary loads reuse Seatline's cache", async () => {
    const { hostedFetch, seen } = await withCompanion();
    await hostedFetch("/providers"); await hostedFetch("/models");
    expect(seen.filter(request => request.provider === "codex").map(request => request.params)).toEqual([{ mode: "cached", max_age_ms: 30000 }]);
    seen.length = 0;
    await Promise.all([hostedFetch("/providers?fresh=1"), hostedFetch("/models?fresh=1")]);
    const codex = seen.filter(request => request.provider === "codex");
    expect(codex).toEqual([{ provider: "codex", method: "readiness", params: { mode: "fresh" } }]);
    expect(seen.map(request => request.provider).sort()).toEqual(["claude", "codex", "gemini", "grok"]);
  });
});
