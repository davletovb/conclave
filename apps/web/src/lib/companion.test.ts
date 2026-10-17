import { describe, expect, it, vi } from "vitest";
import { MAX_RUNNING_REQUESTS, SeatlineConnection, SeatlineFailure, failureReason, type SeatlineEnvironment, type SeatlineEvent } from "./companion";
import { importKey, newNonce, openFrame, openHello, sealFrame, sealHello, type Epoch } from "./seatline-protocol";

const KEY_BYTES = crypto.getRandomValues(new Uint8Array(32));
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ID = "a".repeat(64), TOKEN = "b".repeat(64);

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1; bufferedAmount = 0;
  onopen?: () => void; onerror?: () => void; onmessage?: (message: { data: string }) => void;
  sent: any[] = []; closedWith: number | undefined; closed = false;
  constructor(readonly url: URL) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  onclose?: (event?: { code?: number; reason?: string }) => void;
  close(code?: number, reason?: string) { if (this.closed) return; this.closed = true; this.closedWith = code; this.readyState = 3; this.onclose?.({ code, reason }); }
  deliver(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(check: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) { const value = check(); if (value) return value; await wait(5); }
  throw new Error(`timed out waiting for ${what}`);
}

/** A pairing, a connection to it, and a stand-in for the companion at the other end of the relay. */
function setup(options: { timeoutMs?: number; noticeMs?: number; linked?: boolean; env?: Partial<SeatlineEnvironment> } = {}) {
  FakeSocket.all = [];
  const stored = new Map<string, string>();
  const env: SeatlineEnvironment = {
    relayUrl: "https://relay.test",
    openSocket: url => new FakeSocket(url) as unknown as WebSocket,
    storage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: k => void stored.delete(k) },
    hash: () => options.linked === false ? "" : `#seatline=${ID}:${TOKEN}:${base64url(KEY_BYTES)}`,
    clearFragment: () => {},
    connectTimeoutMs: options.timeoutMs ?? 2000,
    queueNoticeMs: options.noticeMs,
    ...options.env,
  };
  const connection = new SeatlineConnection(env);
  const keyPromise = importKey(KEY_BYTES);
  return { connection, stored, keyPromise };
}

/** What the companion does at each step, using the protocol functions. */
async function companionOf(keyPromise: Promise<CryptoKey>) {
  const key = await keyPromise;
  return {
    key,
    async accept(socket: FakeSocket) {
      socket.onopen?.();
      expect(socket.sent[0]).toEqual({ type: "auth", token: TOKEN });
      socket.deliver({ type: "ready", peer: true });
    },
    /** Answers the browser's hello the way the helper does and returns the agreed epoch. */
    async answer(socket: FakeSocket, fromIndex = 1): Promise<{ epoch: Epoch; browserFrames: () => any[] }> {
      const hello = await until(() => socket.sent.slice(fromIndex).find(frame => frame.seq === 0), "the browser's hello");
      const { nonce, echo } = await openHello(key, "browser", hello);
      expect(echo).toBeNull();
      const epoch = { helper: newNonce(), browser: nonce };
      socket.deliver(await sealHello(key, "helper", epoch.helper, nonce));
      return { epoch, browserFrames: () => socket.sent.filter(frame => frame.seq > 0) };
    },
    async say(socket: FakeSocket, epoch: Epoch, seq: number, packet: unknown) { socket.deliver(await sealFrame(key, "helper", epoch, seq, packet)); },
  };
}

describe("Seatline connection, web protocol 2", () => {
  it("handshakes, then numbers both directions from 1 within the epoch", async () => {
    const { connection, stored, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const events: SeatlineEvent[] = [];
    const done = connection.request("codex", "send", { text: "hi" }, event => events.push(event));
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { epoch, browserFrames } = await helper.answer(socket);

    const frame = await until(() => browserFrames()[0], "the request frame");
    expect(frame.seq).toBe(1);
    const request = await openFrame(helper.key, "browser", epoch, frame) as { id: string; provider: string; method: string };
    expect(request).toMatchObject({ provider: "codex", method: "send" });
    await helper.say(socket, epoch, 1, { id: request.id, event: { type: "delta", text: "Hello" } });
    await helper.say(socket, epoch, 2, { id: request.id, event: { type: "completed" } });
    await done;
    expect(events).toEqual([{ type: "delta", text: "Hello" }]);
    // The saved pairing holds no sequence counters: they only live inside a handshake.
    expect(JSON.parse(stored.get("conclave.seatline.pair.v2")!)).toEqual({ id: ID, token: TOKEN, key: base64url(KEY_BYTES), relay: "https://relay.test" });
  });

  it.each([
    ["a lost frame", (epoch: Epoch) => [[1, "ok"], [3, "skipped"]] as const],
    ["a repeated frame", (epoch: Epoch) => [[1, "ok"], [1, "again"]] as const],
  ])("drops the connection on %s, then recovers with a fresh handshake", async (_name, script) => {
    const { connection, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const first = connection.request("codex", "send", {}, () => {});
    const failure = first.then(() => new Error("the request unexpectedly succeeded"), error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { epoch, browserFrames } = await helper.answer(socket);
    const request = await openFrame(helper.key, "browser", epoch, await until(() => browserFrames()[0], "request")) as { id: string };
    for (const [seq] of script(epoch)) await helper.say(socket, epoch, seq, { id: request.id, event: { type: "delta", text: "x" } });
    const error = await failure;
    expect(error.message).toMatch(/lost a message|Invalid encrypted/);
    expect(socket.closed).toBe(true);
    expect(socket.closedWith).toBe(1008);

    // The next request opens a new connection; both counters start over at 1 and it works.
    const second = connection.request("codex", "status", null, () => {});
    const next = await until(() => FakeSocket.all[1], "the browser to reconnect");
    await helper.accept(next);
    const fresh = await helper.answer(next);
    expect(fresh.epoch.helper).not.toBe(epoch.helper);
    const frame = await until(() => fresh.browserFrames()[0], "the request on the new connection");
    expect(frame.seq).toBe(1);
    const again = await openFrame(helper.key, "browser", fresh.epoch, frame) as { id: string };
    await helper.say(next, fresh.epoch, 1, { id: again.id, event: { type: "completed" } });
    await second;
  });

  it("rejects a frame sealed under another epoch, and data that arrives before any handshake", async () => {
    const { connection, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const failure = connection.request("codex", "send", {}, () => {}).then(() => new Error("the request unexpectedly succeeded"), error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { epoch, browserFrames } = await helper.answer(socket);
    const request = await openFrame(helper.key, "browser", epoch, await until(() => browserFrames()[0], "request")) as { id: string };
    // Correct sequence number and key, but the helper nonce belongs to an earlier connection.
    await helper.say(socket, { ...epoch, helper: newNonce() }, 1, { id: request.id, event: { type: "completed" } });
    expect((await failure).message).toMatch(/Invalid encrypted/);
    expect(socket.closed).toBe(true);

    const early = setup();
    const other = await companionOf(early.keyPromise);
    const waiting = early.connection.request("codex", "send", {}, () => {}).then(() => new Error("the request unexpectedly succeeded"), error => error as Error);
    const raw = await until(() => FakeSocket.all[0], "the browser to connect");
    raw.onopen?.(); raw.deliver({ type: "ready", peer: true });
    raw.deliver(await sealFrame(other.key, "helper", { helper: newNonce(), browser: newNonce() }, 1, { id: "x", event: { type: "completed" } }));
    expect((await waiting).message).toMatch(/before the handshake/);
  });

  it("interrupts what was running when the companion reconnects, and restarts the counters", async () => {
    const { connection, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const running = connection.request("codex", "send", {}, () => {}).then(() => new Error("the request unexpectedly succeeded"), error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const first = await helper.answer(socket);
    await until(() => first.browserFrames()[0], "request");

    // The relay reports the helper again without the socket closing.
    socket.deliver({ type: "peer", connected: true });
    expect((await running).message).toMatch(/reconnected/);
    const second = await helper.answer(socket, socket.sent.length - 0 > 2 ? 3 : 1);
    expect(second.epoch.browser).not.toBe(first.epoch.browser);

    const later = connection.request("codex", "status", null, () => {});
    const frame = await until(() => socket.sent.filter(f => f.seq > 0)[1], "a request in the new epoch");
    expect(frame.seq).toBe(1);
    const request = await openFrame(helper.key, "browser", second.epoch, frame) as { id: string };
    await helper.say(socket, second.epoch, 1, { id: request.id, event: { type: "completed" } });
    await later;
  });

  it("fails what was running when the companion goes away", async () => {
    const { connection, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const running = connection.request("codex", "send", {}, () => {}).then(() => new Error("the request unexpectedly succeeded"), error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { browserFrames } = await helper.answer(socket);
    await until(() => browserFrames()[0], "request");
    socket.deliver({ type: "peer", connected: false });
    expect((await running).message).toMatch(/disconnected/);
    expect(socket.closed).toBe(true);
  });

  it("times out, naming the protocol, when the companion never answers the hello", async () => {
    const { connection } = setup({ timeoutMs: 60 });
    const waiting = connection.request("codex", "send", {}, () => {}).then(() => new Error("the request unexpectedly succeeded"), error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    socket.onopen?.(); socket.deliver({ type: "ready", peer: true });
    // An older companion would simply say nothing to a protocol 2 hello.
    expect((await waiting).message).toMatch(/protocol 2/);
  });

  it("ignores an answer to a hello it did not send", async () => {
    const { connection, keyPromise } = setup({ timeoutMs: 120 });
    const helper = await companionOf(keyPromise);
    const waiting = connection.request("codex", "send", {}, () => {}).then(() => new Error("the request unexpectedly succeeded"), error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    await until(() => socket.sent.find(frame => frame.seq === 0), "the hello");
    // A replay of an earlier answer: authentic, but it echoes some other nonce.
    socket.deliver(await sealHello(helper.key, "helper", newNonce(), newNonce()));
    expect((await waiting).message).toMatch(/did not answer/);
  });

  it("sends a cancel frame, with the next sequence number, when a request is aborted", async () => {
    const { connection, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const controller = new AbortController();
    const aborted = connection.request("codex", "send", {}, () => {}, controller.signal).then(() => new Error("the request unexpectedly succeeded"), error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { epoch, browserFrames } = await helper.answer(socket);
    const request = await openFrame(helper.key, "browser", epoch, await until(() => browserFrames()[0], "request")) as { id: string };
    controller.abort();
    expect((await aborted).name).toBe("AbortError");
    const cancel = await until(() => browserFrames()[1], "the cancel frame");
    expect(cancel.seq).toBe(2);
    expect(await openFrame(helper.key, "browser", epoch, cancel)).toMatchObject({ method: "cancel", target: request.id });
  });

  it("sends no more than the companion will run, says so while a request waits, and starts it when a slot frees", async () => {
    expect(MAX_RUNNING_REQUESTS).toBe(2);
    const { connection, keyPromise } = setup({ noticeMs: 25 });
    const helper = await companionOf(keyPromise);
    const notices: string[][] = [[], [], []];
    const runs = notices.map((seen, index) => connection.request("codex", "send", { index }, event => seen.push(event.type)));
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { epoch, browserFrames } = await helper.answer(socket);

    await until(() => browserFrames().length >= 2, "two requests on the wire");
    await wait(120);
    expect(browserFrames()).toHaveLength(2); // the third is held back here, not queued out of sight
    expect(notices[2].filter(type => type === "queued").length).toBeGreaterThanOrEqual(2);
    expect(notices[0]).not.toContain("queued");

    const first = await openFrame(helper.key, "browser", epoch, browserFrames()[0]) as { id: string };
    await helper.say(socket, epoch, 1, { id: first.id, event: { type: "completed" } });
    await runs[0];
    const third = await until(() => browserFrames()[2], "the waiting request to start");
    expect(third.seq).toBe(3);
    // Every slot comes back when a request ends, however it ends.
    const others = [browserFrames()[1], third];
    let helperSeq = 1;
    for (const frame of others) {
      const { id } = await openFrame(helper.key, "browser", epoch, frame) as { id: string };
      await helper.say(socket, epoch, ++helperSeq, { id, event: { type: "completed" } });
    }
    await Promise.all(runs);
  });

  it("stops waiting for a slot when the request is aborted", async () => {
    const { connection, keyPromise } = setup({ noticeMs: 1000 });
    const helper = await companionOf(keyPromise);
    const first = connection.request("codex", "send", {}, () => {}).catch(() => {});
    const second = connection.request("codex", "send", {}, () => {}).catch(() => {});
    const controller = new AbortController();
    const waiting = connection.request("codex", "send", {}, () => {}, controller.signal).then(() => new Error("ran"), error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { browserFrames } = await helper.answer(socket);
    await until(() => browserFrames().length >= 2, "two requests on the wire");
    controller.abort();
    expect((await waiting).name).toBe("AbortError");
    expect(browserFrames()).toHaveLength(2);
    void first; void second;
  });
});

describe("what the app can learn about its companion", () => {
  it("rejects a failed request with Seatline's reason, as the message it always had and as a reason to branch on", async () => {
    const { connection, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const run = connection.request("codex", "readiness", { mode: "cached", max_age_ms: 30000 }, () => {}).then(() => undefined, error => error as unknown);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { epoch, browserFrames } = await helper.answer(socket);
    const request = await openFrame(helper.key, "browser", epoch, await until(() => browserFrames()[0], "request")) as { id: string; params: unknown };
    expect(request.params).toEqual({ mode: "cached", max_age_ms: 30000 });
    await helper.say(socket, epoch, 1, { id: request.id, event: { type: "failed", reason: "INVALID_REQUEST" } });
    const error = await run;
    expect(error).toBeInstanceOf(SeatlineFailure);
    expect(error).toMatchObject({ message: "INVALID_REQUEST", reason: "INVALID_REQUEST" });
    expect(failureReason(error)).toBe("INVALID_REQUEST");
    // Code that stands in for the connection may throw a plain Error carrying the reason; a request that failed without one says so.
    expect(failureReason(new Error("READINESS_CHANGED"))).toBe("READINESS_CHANGED");
    expect(failureReason("not an error")).toBeUndefined();
  });

  it("counts handshakes, so what was learned about a companion is forgotten when it reconnects", async () => {
    const { connection, keyPromise } = setup();
    expect(connection.generation).toBe(0);
    const helper = await companionOf(keyPromise);
    const run = connection.request("codex", "status", null, () => {}).catch(() => {});
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    await helper.answer(socket);
    await until(() => connection.generation === 1 || undefined, "the first handshake to complete");
    socket.deliver({ type: "peer", connected: true }); // the companion reconnects through the same relay socket
    await helper.answer(socket, socket.sent.length - 0 > 2 ? 3 : 1);
    await until(() => connection.generation === 2 || undefined, "the second handshake to complete");
    await run;
  });

  it("says when a request would have to wait for a running slot, so optional work can stay out of the way", async () => {
    const { connection, keyPromise } = setup({ noticeMs: 1000 });
    const helper = await companionOf(keyPromise);
    expect(connection.congested).toBe(false);
    const runs = [0, 1].map(index => connection.request("codex", "send", { index }, () => {}).catch(() => {}));
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { browserFrames } = await helper.answer(socket);
    await until(() => browserFrames().length >= 2, "two requests on the wire");
    expect(connection.congested).toBe(true);
    void runs;
  });
});

describe("which mode the app runs in", () => {
  const modeWith = async (env: { DEV: boolean; relay?: string; api?: string }) => {
    vi.resetModules();
    vi.stubEnv("DEV", env.DEV);
    vi.stubEnv("VITE_SEATLINE_RELAY", env.relay ?? "");
    vi.stubEnv("VITE_CONCLAVE_API", env.api ?? "");
    const module = await import("./companion");
    vi.unstubAllEnvs();
    return module.usesCompanion;
  };
  it.each([
    ["a development build with no relay keeps the local server", { DEV: true }, false],
    ["a development build with a relay uses the companion", { DEV: true, relay: "https://relay.test" }, true],
    ["a production build with a relay uses the companion", { DEV: false, relay: "https://relay.test" }, true],
    ["a production build that names a standalone server keeps using it", { DEV: false, api: "https://conclave.internal" }, false],
    ["a production build with neither is the hosted app, and says it needs a relay", { DEV: false }, true],
  ])("%s", async (_name, env, expected) => {
    expect(await modeWith(env)).toBe(expected);
  });
});


describe("optional preparation admission", () => {
  it("reserves once before handshake, skips a four-provider burst, and leaves foreground capacity", async () => {
    const { connection, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const optional = ["codex", "claude", "gemini", "grok"].map(provider => connection.tryPrepare(provider, {}, () => {}));
    await expect(Promise.all(optional.slice(1))).resolves.toEqual([false, false, false]);
    const foregroundEvents: SeatlineEvent[] = [];
    const foreground = connection.request("codex", "send", {}, event => foregroundEvents.push(event));
    const socket = await until(() => FakeSocket.all[0], "connection");
    await helper.accept(socket);
    const { epoch, browserFrames } = await helper.answer(socket);
    await until(() => browserFrames().length === 2, "preparation and foreground request");
    const requests = await Promise.all(browserFrames().map(frame => openFrame(helper.key, "browser", epoch, frame))) as Array<{id: string; method: string}>;
    expect(requests.map(request => request.method).sort()).toEqual(["prepare", "send"]);
    expect(foregroundEvents).toEqual([]);
    const prep = requests.find(request => request.method === "prepare")!;
    const send = requests.find(request => request.method === "send")!;
    await helper.say(socket, epoch, 1, { id: send.id, event: { type: "completed" } }); await foreground;
    await expect(connection.tryPrepare("grok", {}, () => {})).resolves.toBe(false);
    await helper.say(socket, epoch, 2, { id: prep.id, event: { type: "completed" } });
    await expect(optional[0]).resolves.toBe(true);
    expect(browserFrames()).toHaveLength(2); // skipped preparation never queues later
    const next = connection.tryPrepare("gemini", {}, () => {});
    const frame = await until(() => browserFrames()[2], "later preparation");
    const later = await openFrame(helper.key, "browser", epoch, frame) as {id: string};
    await helper.say(socket, epoch, 3, {id: later.id, event: {type: "completed"}});
    await expect(next).resolves.toBe(true); connection.close();
  });

  it("sees foreground reservations before handshake and releases optional capacity after failure", async () => {
    const { connection, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const first = connection.request("codex", "send", {}, () => {}).catch(error => error);
    const second = connection.request("claude", "send", {}, () => {}).catch(error => error);
    await expect(connection.tryPrepare("gemini", {}, () => {})).resolves.toBe(false);
    const socket = await until(() => FakeSocket.all[0], "connection");
    socket.close(); await Promise.all([first, second]);
    const failed = connection.tryPrepare("codex", {}, () => {}).catch(error => error);
    const next = await until(() => FakeSocket.all[1], "optional connection");
    next.close(); expect(await failed).toBeInstanceOf(Error);
    const recovered = connection.tryPrepare("codex", {}, () => {});
    const final = await until(() => FakeSocket.all[2], "recovered connection");
    await helper.accept(final); const {epoch, browserFrames} = await helper.answer(final);
    const frame = await until(() => browserFrames()[0], "recovered preparation");
    const request = await openFrame(helper.key, "browser", epoch, frame) as {id: string};
    await helper.say(final, epoch, 1, {id: request.id, event: {type: "completed"}});
    await expect(recovered).resolves.toBe(true); connection.close();
  });
});

describe("where this tab stands with Seatline", () => {
  it("is unpaired with no pairing, and says how to connect when asked for anything", async () => {
    const { connection } = setup({ linked: false });
    expect(connection.state).toEqual({ kind: "unpaired" });
    await expect(connection.request("codex", "status", null, () => {})).rejects.toThrow(/Connect Seatline/);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("goes from connecting to connected through the handshake, and tells its listeners", async () => {
    const { connection, keyPromise } = setup();
    const helper = await companionOf(keyPromise);
    const seen: string[] = [];
    connection.subscribe(() => seen.push(connection.state.kind));
    expect(connection.state.kind).toBe("connecting");
    const done = connection.request("codex", "status", null, () => {});
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    const { epoch, browserFrames } = await helper.answer(socket);
    await until(() => connection.state.kind === "connected", "the handshake");
    const request = await openFrame(helper.key, "browser", epoch, await until(() => browserFrames()[0], "request")) as { id: string };
    await helper.say(socket, epoch, 1, { id: request.id, event: { type: "completed" } });
    await done;
    expect(seen).toEqual(["connected"]);
  });

  it("waits while the relay says Seatline is not there, then says Seatline is not answering", async () => {
    const { connection } = setup({ timeoutMs: 80 });
    const failed = connection.request("codex", "status", null, () => {}).then(() => undefined, error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    socket.onopen?.(); socket.deliver({ type: "ready", peer: false });
    await until(() => connection.state.kind === "waiting", "the waiting state");
    expect((await failed)?.message).toMatch(/isn't answering from this computer/);
    expect(connection.state).toMatchObject({ kind: "unavailable", message: expect.stringMatching(/running/) });
  });

  it("forgets a pairing the relay no longer has, and says to connect again", async () => {
    const { connection, stored } = setup();
    const failed = connection.request("codex", "status", null, () => {}).then(() => undefined, error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    expect(stored.has("conclave.seatline.pair.v2")).toBe(true);
    socket.close(4410, "Pairing expired");
    expect((await failed)?.message).toMatch(/expired/);
    expect(stored.has("conclave.seatline.pair.v2")).toBe(false);
    expect(connection.state).toMatchObject({ kind: "unpaired", message: expect.stringMatching(/expired/) });
  });

  it("is unavailable, not unpaired, when the relay cannot be reached", async () => {
    const { connection, stored } = setup();
    const failed = connection.request("codex", "status", null, () => {}).then(() => undefined, error => error as Error);
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    socket.close(1006);
    expect((await failed)?.message).toMatch(/Can't reach the Seatline relay/);
    expect(stored.has("conclave.seatline.pair.v2")).toBe(true);
    expect(connection.state.kind).toBe("unavailable");
  });

  it("drops a kept pairing made at another relay", async () => {
    const { connection, stored } = setup({ linked: false });
    stored.set("conclave.seatline.pair.v2", JSON.stringify({ id: ID, token: TOKEN, key: base64url(KEY_BYTES), relay: "https://old-relay.test" }));
    await expect(connection.request("codex", "status", null, () => {})).rejects.toThrow(/Connect Seatline/);
    expect(stored.size).toBe(0);
  });
});

describe("connecting this browser to Seatline on this computer", () => {
  const LOCAL = "http://127.0.0.1:27183";
  function local(options: { blocked?: boolean; pairTimeoutMs?: number } = {}) {
    const opened: string[] = [];
    const popup = { closed: false, close() { this.closed = true; } };
    let listener: ((event: { origin: string; source: unknown; data: unknown }) => void) | undefined;
    const harness = setup({ linked: false, env: {
      origin: "https://conclave.test", app: "conclave", localPort: 27183, pairTimeoutMs: options.pairTimeoutMs ?? 2000,
      openWindow: url => { opened.push(url); return options.blocked ? null : popup; },
      listen: next => { listener = next; return () => { listener = undefined; }; },
    } });
    const post = (data: unknown, origin = LOCAL, source: unknown = popup) => listener?.({ origin, source, data });
    return { ...harness, opened, popup, post, listening: () => Boolean(listener) };
  }
  const pairing = { type: "seatline-pairing", version: 1, app: "conclave", relay: "https://relay.test", id: ID, token: TOKEN, key: base64url(KEY_BYTES) };

  it("opens Seatline's page for this site and relay, keeps the pairing it posts back, and connects", async () => {
    const { connection, stored, opened, popup, post, keyPromise } = local();
    const helper = await companionOf(keyPromise);
    const done = connection.pairLocally();
    const url = new URL(opened[0]);
    expect(url.origin).toBe(LOCAL);
    expect(url.pathname).toBe("/connect");
    expect(Object.fromEntries(url.searchParams)).toEqual({ app: "conclave", origin: "https://conclave.test", relay: "https://relay.test" });
    post(pairing);
    await done;
    expect(popup.closed).toBe(true);
    expect(JSON.parse(stored.get("conclave.seatline.pair.v2")!)).toEqual({ id: ID, token: TOKEN, key: base64url(KEY_BYTES), relay: "https://relay.test" });
    // It connects at once, so the app can show it before anything is asked.
    const socket = await until(() => FakeSocket.all[0], "the browser to connect");
    await helper.accept(socket);
    await helper.answer(socket);
    await until(() => connection.state.kind === "connected", "the handshake");
  });

  it("listens only to Seatline's page in the window it opened", async () => {
    const { connection, stored, post, listening } = local({ pairTimeoutMs: 150 });
    const done = connection.pairLocally().then(() => undefined, error => error as Error);
    post(pairing, "https://attacker.test");
    post(pairing, "http://localhost:27183");
    post(pairing, LOCAL, { other: "window" });
    post({ ...pairing, version: 2 });
    expect(stored.size).toBe(0);
    expect((await done)?.message).toMatch(/did not answer/);
    expect(listening()).toBe(false);
  });

  it("refuses a pairing for another relay or a malformed one", async () => {
    for (const bad of [{ ...pairing, relay: "https://elsewhere.test" }, { ...pairing, id: "x" }, { ...pairing, key: "short" }]) {
      const { connection, stored, post } = local();
      const done = connection.pairLocally().then(() => undefined, error => error as Error);
      post(bad);
      expect((await done)?.message).toMatch(/cannot use/);
      expect(stored.size).toBe(0);
    }
  });

  it("passes on what Seatline says when it could not pair", async () => {
    const { connection, post } = local();
    const done = connection.pairLocally();
    post({ type: "seatline-pairing", version: 1, error: "relay_unavailable", message: "Seatline could not get a pairing from the relay." });
    await expect(done).rejects.toThrow("Seatline could not get a pairing from the relay.");
  });

  it("says when the browser blocked the window, or the user closed it", async () => {
    await expect(local({ blocked: true }).connection.pairLocally()).rejects.toThrow(/blocked/);
    const { connection, popup } = local();
    const done = connection.pairLocally();
    popup.closed = true;
    await expect(done).rejects.toThrow(/closed/);
  });
});
