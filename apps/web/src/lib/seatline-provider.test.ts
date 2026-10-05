import { afterEach, describe, expect, it, vi } from "vitest";
import { SeatlineProvider } from "./seatline-provider";
import { SeatlineFailure, type SeatlineClient, type SeatlineEvent, type SeatlineLink } from "./companion";

type Status = NonNullable<SeatlineEvent["status"]>;
type Call = { provider: string; method: string; params: any };

const ready = (signIn: string | undefined, extra: Partial<Status> = {}): Status =>
  ({ availability: "available", authentication: "authenticated", sign_in: signIn, models: [], ...extra });

/**
 * A companion at the other end. `legacy` is one that predates Seatline's readiness API: it refuses those methods as an unknown request.
 * `age` is how old the evidence a readiness answer reports is; `refuse` lists reasons a checked send is refused with, one per attempt.
 */
function companion(signIn?: string, options: { legacy?: boolean; age?: number; refuse?: string[]; failSend?: string } = {}) {
  const calls: Call[] = [];
  const state = { signIn, age: options.age ?? 0, refuse: [...(options.refuse ?? [])], failSend: options.failSend, statusOnSend: undefined as string | undefined };
  const sentSignIn = () => state.statusOnSend ?? state.signIn;
  const client: SeatlineClient = {
    async request(provider, method, params, emit) {
      calls.push({ provider, method, params });
      const readiness = { source: state.age ? "cached" : "fresh", age_ms: state.age };
      if (options.legacy && ["readiness", "prepare", "send_ready_with_policy"].includes(method)) throw new SeatlineFailure("INVALID_REQUEST");
      if (method === "status") emit({ type: "status", status: ready(state.signIn) });
      if (method === "readiness" || method === "prepare") emit({ type: "status", status: ready(state.signIn, { readiness }) });
      if (method === "send" || method === "send_ready_with_policy") {
        if (method === "send_ready_with_policy") emit({ type: "status", status: ready(sentSignIn(), { readiness }) });
        const refusal = method === "send_ready_with_policy" ? state.refuse.shift() : undefined;
        if (refusal) throw new SeatlineFailure(refusal);
        if (state.failSend) throw new SeatlineFailure(state.failSend);
        emit({ type: "delta", text: "Shared subscription response" });
      }
    },
  };
  client.tryPrepare = (provider, params, emit) => client.request(provider, "prepare", params, emit).then(() => true);
  return { client, calls, state, methods: () => calls.map(call => call.method) };
}

const ask = (provider: SeatlineProvider) => provider.generate({ model: "any", messages: [{ role: "user", content: "Hello" }] });
const codex = (client: SeatlineClient, link?: SeatlineLink) => new SeatlineProvider("openai", "OpenAI Codex", "codex", client, link);

afterEach(() => { vi.useRealTimers(); });

describe("Conclave subscription use through Seatline", () => {
  it.each([false, true])("keeps readiness reuse across the first 0 -> 1 handshake (prepared=%s)", async prepared => {
    let generation = 0;
    const f = companion("subscription");
    const original = f.client.request.bind(f.client);
    f.client.request = async (...args) => { if (generation === 0) generation = 1; await original(...args); };
    const provider = codex(f.client, {generation: () => generation, congested: () => false});
    if (prepared) expect(await provider.prepare()).toBe("prepared");
    await ask(provider);
    expect(f.methods()).toEqual([prepared ? "prepare" : "readiness", "send_ready_with_policy"]);
    expect(f.calls.at(-1)?.params).toMatchObject({allowed_sign_in: ["subscription"], turn: {check_sign_in: false}});
  });

  it("requires an updated companion when readiness exists but the protected send method does not", async () => {
    const f = companion("subscription", {failSend: "INVALID_REQUEST"});
    await expect(ask(codex(f.client))).rejects.toThrow("Update your Seatline companion");
    expect(f.methods()).toEqual(["readiness", "send_ready_with_policy"]);
  });

  it("offers the real provider default when a CLI has no model catalogue", async () => {
    const { client, calls } = companion("subscription");
    const provider = codex(client);
    const models = await provider.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ provider: "openai", source: "subscription", isDefault: true });
    expect(await provider.generate({ model: models[0].model, messages: [{ role: "user", content: "Hello" }] }))
      .toMatchObject({ provider: "openai", content: "Shared subscription response" });
    // The turn runs under the readiness just checked, so Seatline does not probe sign-in a second time inside it.
    expect(calls.find(call => call.method === "send_ready_with_policy")).toMatchObject({ provider: "codex", params: {
      freshness: { mode: "cached", max_age_ms: 30000 },
      turn: { model: null, tools: "none", session: "ephemeral", continuation: null, cleanup_group: null, check_sign_in: false },
    } });
  });

  it.each(["api_key", "unknown", undefined])("refuses %s authentication before a paid provider turn", async signIn => {
    const { client, calls } = companion(signIn);
    const provider = codex(client);
    expect(await provider.listModels()).toEqual([]);
    await expect(ask(provider)).rejects.toThrow("verified subscription");
    expect(calls.some(call => call.method === "send" || call.method === "send_ready_with_policy")).toBe(false);
  });

  it("accepts the Google cloud account mode only for Google", async () => {
    const { client, calls } = companion("cloud");
    const google = new SeatlineProvider("google", "Google Gemini", "gemini", client);
    const openai = codex(client);
    expect(await google.status()).toMatchObject({ connected: true });
    expect(await openai.status()).toMatchObject({ connected: false });
    await ask(google);
    expect(calls.at(-1)?.params.allowed_sign_in).toEqual(["subscription", "cloud"]);
  });

  it("checks readiness once for several steps of a run, and again once the answer is stale or unusable", async () => {
    const { client, methods } = companion("subscription");
    const provider = codex(client);
    await Promise.all([ask(provider), ask(provider), ask(provider)]);
    await ask(provider);
    expect(methods().filter(method => method === "readiness")).toHaveLength(1);
    expect(methods().filter(method => method === "send_ready_with_policy")).toHaveLength(4);
    expect(methods()).not.toContain("status");
    expect(methods()).not.toContain("send");
  });

  it("checks again rather than trusting an earlier answer that said the provider was unusable", async () => {
    const { client, state, methods } = companion("api_key");
    const provider = codex(client);
    await expect(ask(provider)).rejects.toThrow("verified subscription");
    state.signIn = "subscription"; // the user signed in
    await expect(ask(provider)).resolves.toMatchObject({ content: "Shared subscription response" });
    // The first run asked, and asked again as a new check; the second reused nothing it could not trust and asked once more.
    expect(methods().filter(method => method === "readiness")).toHaveLength(3);
  });

  it("does not remember a failed readiness request", async () => {
    let attempts = 0;
    const client: SeatlineClient = {
      async request(_provider, method, _params, emit) {
        if (method === "readiness" && ++attempts === 1) throw new Error("companion offline");
        if (method === "readiness") emit({ type: "status", status: ready("subscription") });
      },
    };
    const provider = codex(client);
    expect(await provider.status()).toMatchObject({ connected: false, message: "companion offline" });
    expect(await provider.status()).toMatchObject({ connected: true });
  });

  it("turns a queued notice into run activity, so a step waiting for the companion is not counted as stalled", async () => {
    const client: SeatlineClient = {
      async request(_provider, method, _params, emit) {
        if (method === "readiness") emit({ type: "status", status: ready("subscription") });
        if (method === "send_ready_with_policy") { emit({ type: "queued" }); emit({ type: "status", status: ready("subscription") }); emit({ type: "delta", text: "done" }); }
      },
    };
    const events: unknown[] = [];
    await codex(client).generate({ model: "any", messages: [{ role: "user", content: "Hi" }] }, event => events.push(event));
    expect(events).toContainEqual({ type: "status", message: expect.stringContaining("Waiting for your Seatline companion") });
  });
});

describe("reusing Seatline's readiness", () => {
  it("never reuses evidence that is as old as Seatline's own window, however recently it was fetched", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const { client, methods } = companion("subscription", { age: 25_000 }); // Seatline answered from a 25-second-old check
    const provider = codex(client);
    await ask(provider);
    vi.setSystemTime(1_004_000); await ask(provider); // 29 s old: still within the window
    expect(methods().filter(method => method === "readiness")).toHaveLength(1);
    vi.setSystemTime(1_006_000); await ask(provider); // 31 s old: the answer is 6 s old but its evidence is too old to reuse
    expect(methods().filter(method => method === "readiness")).toHaveLength(2);
  });

  it("asks for a new check, here and in Seatline, when the user asks (a retry after signing in), and shares it between callers", async () => {
    const { client, calls } = companion("subscription");
    const provider = codex(client);
    await provider.status();
    await Promise.all([provider.status({ fresh: true }), provider.listModels({ fresh: true })]); // the status list and the model list at once
    const readiness = calls.filter(call => call.method === "readiness");
    expect(readiness.map(call => call.params)).toEqual([{ mode: "cached", max_age_ms: 30000 }, { mode: "fresh" }]);
  });

  it("applies Conclave's own account rule to the status the send ran under, and stops a turn that changed account", async () => {
    const { client, state, calls } = companion("subscription");
    const provider = codex(client);
    state.statusOnSend = "api_key"; // the account changed between the check and the send
    await expect(ask(provider)).rejects.toThrow("sign-in changed");
    expect(calls.filter(call => call.method === "send_ready_with_policy")).toHaveLength(1);
  });

  it("repeats a send once, from a new check, when Seatline refuses before starting it; a second refusal is final", async () => {
    for (const reason of ["READINESS_CHANGED", "READINESS_EXPIRED", "READINESS_UNVERIFIED"]) {
      const { client, calls } = companion("subscription", { refuse: [reason] });
      await expect(ask(codex(client))).resolves.toMatchObject({ content: "Shared subscription response" });
      expect(calls.map(call => [call.method, call.params.mode ?? call.params.freshness?.mode])).toEqual([
        ["readiness", "cached"], ["send_ready_with_policy", "cached"], ["readiness", "fresh"], ["send_ready_with_policy", "cached"]]);
    }
    const twice = companion("subscription", { refuse: ["READINESS_CHANGED", "READINESS_CHANGED"] });
    await expect(ask(codex(twice.client))).rejects.toThrow("READINESS_CHANGED");
    expect(twice.methods().filter(method => method === "send_ready_with_policy")).toHaveLength(2);
    // Any other failure may have started the turn, so it is not repeated.
    const failed = companion("subscription", { failSend: "PROVIDER_FAILED" });
    await expect(ask(codex(failed.client))).rejects.toThrow("PROVIDER_FAILED");
    expect(failed.methods().filter(method => method === "send_ready_with_policy")).toHaveLength(1);
  });

  it("forgets what it knew after a failed turn, so the next step asks again (auth-failure recovery)", async () => {
    const { client, state, methods } = companion("subscription");
    const provider = codex(client);
    await ask(provider);
    state.failSend = "AUTH_REJECTED"; // the account was signed out behind the cached answer
    await expect(ask(provider)).rejects.toThrow("AUTH_REJECTED");
    state.failSend = undefined; state.signIn = "unknown";
    await expect(ask(provider)).rejects.toThrow("verified subscription"); // it asked again rather than trusting the old answer
    expect(methods().filter(method => method === "readiness").length).toBeGreaterThanOrEqual(2);
    state.signIn = "subscription";
    await expect(ask(provider)).resolves.toMatchObject({ content: "Shared subscription response" });
  });
});

describe("a companion without the readiness API", () => {
  it("shows legacy status but refuses generation without companion policy enforcement", async () => {
    const { client, calls, methods } = companion("subscription", { legacy: true });
    const provider = codex(client);
    await expect(ask(provider)).rejects.toThrow("Update your Seatline companion");
    expect(methods()).toEqual(["readiness", "status"]);
    expect(calls.some(call => call.method === "send" || call.method === "send_ready_with_policy")).toBe(false);
    // The other providers share what the companion has shown.
    const claude = new SeatlineProvider("anthropic", "Claude Code", "claude", client);
    await claude.status();
    expect(methods().slice(2)).toEqual(["status"]);
  });

  it("tries the API again after the companion reconnects, because it may have been updated", async () => {
    let generation = 1; let legacy = true; const calls: string[] = [];
    const link: SeatlineLink = { generation: () => generation, congested: () => false };
    const client: SeatlineClient = {
      async request(_provider, method, _params, emit) {
        calls.push(method);
        if (legacy && ["readiness", "prepare", "send_ready_with_policy"].includes(method)) throw new SeatlineFailure("INVALID_REQUEST");
        if (["status", "readiness", "prepare"].includes(method)) emit({ type: "status", status: ready("subscription") });
        if (method === "send_ready_with_policy") emit({ type: "status", status: ready("subscription") });
        if (method === "send" || method === "send_ready_with_policy") emit({ type: "delta", text: "ok" });
      },
    };
    const provider = codex(client, link);
    await expect(ask(provider)).rejects.toThrow("Update your Seatline companion");
    expect(calls).toEqual(["readiness", "status"]);
    generation = 2; legacy = false; calls.length = 0; // the companion reconnected, updated
    await provider.status({ fresh: true }); await ask(provider);
    expect(calls).toEqual(["readiness", "send_ready_with_policy"]);
  });

  it("does not fall back once the API has answered: an invalid request from it is a real failure", async () => {
    let refuse = false; const calls: string[] = [];
    const client: SeatlineClient = {
      async request(_provider, method, _params, emit) {
        calls.push(method);
        if (refuse && method === "readiness") throw new SeatlineFailure("INVALID_REQUEST");
        if (method === "readiness") emit({ type: "status", status: ready("subscription") });
      },
    };
    const provider = codex(client);
    await provider.status();
    refuse = true; calls.length = 0;
    expect(await provider.status({ fresh: true })).toMatchObject({ connected: false, message: "INVALID_REQUEST" });
    expect(calls).toEqual(["readiness"]);
  });
});

describe("preparing the providers a run is likely to use", () => {
  it("asks for a cached readiness with no prompt, and the run that follows reuses what it learned", async () => {
    const { client, calls, methods } = companion("subscription");
    const provider = codex(client);
    expect(await provider.prepare()).toBe("prepared");
    expect(calls).toEqual([{ provider: "codex", method: "prepare", params: { mode: "cached", max_age_ms: 30000 } }]);
    await ask(provider);
    expect(methods()).toEqual(["prepare", "send_ready_with_policy"]); // no second check: the preparation was one
  });

  it("is best effort: throttled, never an error, and not at all for an older companion or one that is busy", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const { client, methods } = companion("subscription");
    const provider = codex(client);
    expect(await provider.prepare()).toBe("prepared");
    expect(await provider.prepare()).toBe("skipped");
    vi.setSystemTime(1_010_000); expect(await provider.prepare()).toBe("prepared");
    expect(methods()).toEqual(["prepare", "prepare"]);

    let congested = true; const link: SeatlineLink = { generation: () => 1, congested: () => congested };
    const busy = companion("subscription"); const waiting = codex(busy.client, link);
    expect(await waiting.prepare()).toBe("skipped"); expect(busy.calls).toHaveLength(0); // it would queue ahead of a run
    congested = false; expect(await waiting.prepare()).toBe("prepared");

    const old = companion("subscription", { legacy: true }); const legacy = codex(old.client);
    expect(await legacy.prepare()).toBe("skipped"); vi.setSystemTime(1_030_000);
    expect(await legacy.prepare()).toBe("skipped"); expect(old.methods()).toEqual(["prepare"]); // it is not asked again

    const broken: SeatlineClient = { async request() { throw new Error("companion offline"); } };
    await expect(codex(broken).prepare()).resolves.toBe("skipped");
  });

  it("does not make a failed preparation look like a provider that is not ready", async () => {
    let fail = true;
    const client: SeatlineClient = {
      async request(_provider, method, _params, emit) {
        if (method === "prepare" && fail) throw new Error("companion offline");
        if (method === "readiness" || method === "prepare") emit({ type: "status", status: ready("subscription") });
      },
    };
    client.tryPrepare = (provider, params, emit) => client.request(provider, "prepare", params, emit).then(() => true);
    const provider = codex(client);
    expect(await provider.prepare()).toBe("skipped"); fail = false;
    expect(await provider.status()).toMatchObject({ connected: true });
  });
});
