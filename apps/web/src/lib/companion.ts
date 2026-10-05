import { envelopeSequence, importKey, newNonce, openFrame, openHello, sealFrame, sealHello, type Envelope, type Epoch } from "./seatline-protocol";

type Pair = { id: string; token: string; key: string };
/** Seatline's readiness record, present on explicit readiness and preparation results: `source` is `fresh`, `cached` or `shared`; `age_ms` how old the verified evidence is. */
export type SeatlineReadiness = { source: string; age_ms: number };
export type SeatlineEvent = { type: string; text?: string; reason?: string; status?: { availability: string; authentication: string; sign_in?: string; models: Array<{id:string;label:string}>; readiness?: SeatlineReadiness }; usage?: {input_tokens?:number;output_tokens?:number} };
type Packet = {id: string; event: SeatlineEvent};
type Pending = { resolve: () => void; reject: (error: Error) => void; emit: (event: SeatlineEvent) => void; dispose: () => void };

// Version 2 of the saved pairing: the sequence counters of version 1 are gone, because a counter now
// only lives as long as the handshake it belongs to.
const STORAGE = "conclave.seatline.pair.v2";
const LEGACY_STORAGE = "conclave.seatline.pair.v1";
const relayUrl = import.meta.env.VITE_SEATLINE_RELAY as string | undefined;
// A build with a relay talks to the shared companion. So does a production build that names no
// standalone server; one that sets VITE_CONCLAVE_API keeps using that server, as before.
export const usesCompanion = Boolean(relayUrl) || (!import.meta.env.DEV && !import.meta.env.VITE_CONCLAVE_API);

const SOCKET_OPEN = 1; // WebSocket.OPEN

/** A frame the relay lost, repeated or replayed. The connection is dropped and re-established. */
class ProtocolError extends Error {}

/** A request the companion answered with `failed`. The message is the reason, as before; `reason` is the same text for code that branches on it. */
export class SeatlineFailure extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "SeatlineFailure"; }
}
/** The reason a request failed, when it failed in Seatline's words. */
export const failureReason = (error: unknown): string | undefined =>
  error instanceof SeatlineFailure ? error.reason : error instanceof Error ? error.message : undefined;

export type SeatlineEnvironment = {
  relayUrl?: string;
  openSocket: (url: URL) => WebSocket;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** location.hash, which carries the pairing link the first time the page opens. */
  hash: () => string;
  /** Removes the pairing link from the address bar. */
  clearFragment: () => void;
  /** How long to wait for the companion to appear and answer the handshake. */
  connectTimeoutMs?: number;
  /** How often a request waiting for a free slot says so, so the caller can tell it is not stuck. */
  queueNoticeMs?: number;
};

/**
 * The companion runs two requests per app at a time and queues a few more out of sight. Sending no more
 * than it will run keeps every request's wait visible here, where it can be reported, instead of in a queue
 * that says nothing and can overflow.
 */
export const MAX_RUNNING_REQUESTS = 2;

const b64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

/** One browser tab's encrypted connection to the user's Seatline companion through the relay. */
export class SeatlineConnection {
  private socket: WebSocket | undefined;
  private connected: Promise<void> | undefined;
  private key: CryptoKey | undefined;
  private epoch: Epoch | undefined;
  private browserNonce: string | undefined;
  private handshake: Promise<void> = Promise.resolve();
  private handshakeDone: (() => void) | undefined;
  private sent = 0;
  private received = 0;
  private outgoing = Promise.resolve();
  private incoming = Promise.resolve();
  private inbound = 0;
  private readonly pending = new Map<string, Pending>();
  private running = 0;
  private readonly waiting: Array<{ start: () => void; cancel: (error: Error) => void }> = [];
  private handshakes = 0;

  constructor(private readonly env: SeatlineEnvironment) {}

  /** How many times the companion has completed a handshake with this tab. It grows when the companion reconnects, which is when what the app learned about it may no longer hold (it may have been updated). */
  get generation() { return this.handshakes; }

  /** Whether a request made now would have to wait for one of the companion's running slots. */
  get congested() { return this.running >= MAX_RUNNING_REQUESTS || this.waiting.length > 0; }

  private releaseSlot(): () => void {
    let done = false;
    return () => { if (done) return; done = true; this.running--; this.waiting.shift()?.start(); };
  }

  /** Reserve before connection/handshake work. The release is idempotent. */
  private acquire(notice: () => void, signal?: AbortSignal): Promise<() => void> {
    if (this.running < MAX_RUNNING_REQUESTS && this.waiting.length === 0) { this.running++; return Promise.resolve(this.releaseSlot()); }
    return new Promise((resolve, reject) => {
      const ticker = setInterval(notice, this.env.queueNoticeMs ?? 20_000);
      const stop = () => { clearInterval(ticker); signal?.removeEventListener("abort", onAbort); };
      const waiter = {
        start: () => { stop(); this.running++; resolve(this.releaseSlot()); },
        cancel: (error: Error) => { stop(); reject(error); },
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(waiter); if (at >= 0) this.waiting.splice(at, 1);
        waiter.cancel(new DOMException("Run cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private pairing(): Pair {
    const { storage } = this.env;
    const fragment = new URLSearchParams(this.env.hash().slice(1)).get("seatline");
    if (fragment) {
      const [id, token, key] = fragment.split(":");
      this.env.clearFragment();
      if (!/^[a-f0-9]{64}$/.test(id ?? "") || !/^[a-f0-9]{64}$/.test(token ?? "") || !/^[a-zA-Z0-9_-]{43}$/.test(key ?? "")) throw new Error("Invalid Seatline pairing link");
      storage.setItem(STORAGE, JSON.stringify({ id, token, key }));
      storage.removeItem(LEGACY_STORAGE);
    }
    const saved = storage.getItem(STORAGE);
    if (!saved) throw new Error("Open Conclave from the Seatline companion to connect this browser.");
    const pair: Pair = JSON.parse(saved);
    if (!/^[a-f0-9]{64}$/.test(pair.id) || !/^[a-f0-9]{64}$/.test(pair.token) || !/^[a-zA-Z0-9_-]{43}$/.test(pair.key)) throw new Error("Invalid saved Seatline pairing");
    return pair;
  }

  /** Rejects what is in flight without touching the connection: the helper dropped it. */
  private interrupt(error: Error) {
    for (const item of this.pending.values()) { item.dispose(); item.reject(error); }
    this.pending.clear();
  }

  private fail(error: Error) {
    this.epoch = undefined; this.browserNonce = undefined;
    this.interrupt(error);
    this.connected = undefined;
  }

  private async beginHandshake(socket: WebSocket) {
    // A fresh nonce for every handshake: nothing sent under an earlier one can be replayed into this one.
    this.epoch = undefined; this.sent = 0; this.received = 0;
    this.browserNonce = newNonce();
    this.handshake = new Promise<void>(resolve => { this.handshakeDone = resolve; });
    const hello = await sealHello(this.key!, "browser", this.browserNonce);
    if (socket === this.socket && socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify(hello));
  }

  private async onFrame(envelope: Envelope, settle: () => void) {
    const sequence = envelopeSequence(envelope);
    if (sequence === 0) {
      const hello = await openHello(this.key!, "helper", envelope);
      // An answer to an earlier hello of ours, or a replay of one, is not an answer to this one.
      if (!this.browserNonce || hello.echo !== this.browserNonce) return;
      this.epoch = { helper: hello.nonce, browser: this.browserNonce };
      this.sent = 0; this.received = 0; this.handshakes++;
      settle(); this.handshakeDone?.();
      return;
    }
    if (!this.epoch) throw new ProtocolError("The companion sent data before the handshake");
    // Exactly the next frame. A gap is a lost frame and a repeat a replay; either way the connection
    // is dropped and the next handshake starts both counters again.
    if (sequence !== this.received + 1) throw new ProtocolError("Seatline lost a message on the way; reconnecting");
    const packet = await openFrame(this.key!, "helper", this.epoch, envelope) as Packet;
    this.received = sequence;
    const item = this.pending.get(packet.id); if (!item) return;
    if (!packet.event || typeof packet.event.type !== "string") throw new Error("Invalid companion provider event");
    const event = packet.event;
    if (["completed","failed","stopped"].includes(event.type)) {
      this.pending.delete(packet.id); item.dispose();
      if (event.type === "completed") item.resolve();
      else if (event.type === "stopped") { const error = new Error("Run cancelled"); error.name = "AbortError"; item.reject(error); }
      else item.reject(new SeatlineFailure(event.reason ?? "Provider failed"));
    } else {
      try { item.emit(event); } catch (error) {
        this.pending.delete(packet.id); item.dispose(); item.reject(error instanceof Error ? error : new Error("Provider event rejected"));
        void this.send({ id: crypto.randomUUID(), method: "cancel", target: packet.id }).catch(() => {});
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.connected) return this.connected;
    if (!this.env.relayUrl) throw new Error("The hosted website needs a configured Seatline relay.");
    const relay = new URL(this.env.relayUrl);
    if (relay.protocol !== "https:") throw new Error("Seatline relay must use HTTPS");
    const pair = this.pairing();
    const endpoint = new URL(`/channels/${pair.id}/browser`, relay); endpoint.protocol = "wss:";
    this.key = await importKey(b64(pair.key));
    // Share connection creation across concurrent catalogue/bootstrap requests.
    if (this.connected) return this.connected;
    const current = this.env.openSocket(endpoint); this.socket = current;
    this.connected = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = () => { clearTimeout(timer); settled = true; resolve(); };
      const timer = setTimeout(() => { reject(new Error("Seatline companion did not answer. Open the companion (it must speak web protocol 2) and try again.")); current.close(); }, this.env.connectTimeoutMs ?? 15_000);
      current.onopen = () => current.send(JSON.stringify({ type: "auth", token: pair.token }));
      current.onmessage = message => {
        if (typeof message.data !== "string" || message.data.length > 768 * 1024 || ++this.inbound > 128) { current.close(1008); this.inbound--; return; }
        this.incoming = this.incoming.then(async () => {
          if (current !== this.socket) return;
          const envelope = JSON.parse(message.data);
          if (envelope.type === "ready" || envelope.type === "peer") {
            const peer = envelope.peer === true || envelope.connected === true;
            if (!peer) {
              this.epoch = undefined;
              if (settled) { this.fail(new Error("Seatline companion disconnected")); current.close(); }
              return;
            }
            // The companion is (re)connected: what ran before it is gone, and a new epoch begins.
            this.interrupt(new Error("Seatline companion reconnected; the request was interrupted"));
            await this.beginHandshake(current);
            return;
          }
          if (envelope.type === "pong") return;
          if (envelope.type !== "data") return;
          await this.onFrame(envelope, settle);
        }).catch(error => {
          const failure = error instanceof ProtocolError ? error : new Error("Invalid encrypted companion response");
          this.fail(failure);
          // Before the handshake finished, the caller is waiting on this promise and should hear why, not
          // the generic close that follows.
          if (!settled) reject(failure);
          current.close(1008);
        }).finally(() => this.inbound--);
      };
      current.onclose = () => { clearTimeout(timer); if (!settled) reject(new Error("Seatline companion is unavailable or pairing expired")); if (current === this.socket) this.fail(new Error("Seatline connection closed")); };
      current.onerror = () => current.close();
    });
    return this.connected;
  }

  private async send(value: unknown) {
    const target = this.socket;
    const key = this.key;
    this.outgoing = this.outgoing.catch(() => {}).then(async () => {
      const epoch = this.epoch;
      if (!target || !key || target !== this.socket || target.readyState !== SOCKET_OPEN || !epoch) throw new Error("Seatline companion is offline");
      const clear = new TextEncoder().encode(JSON.stringify(value));
      if (clear.length > 512 * 1024 || target.bufferedAmount > 2 * 1024 * 1024) throw new Error("Seatline request queue is full");
      const sequence = ++this.sent;
      const frame = await sealFrame(key, "browser", epoch, sequence, value);
      // The helper started over while this was sealed: the frame belongs to an epoch that no longer exists.
      if (this.epoch !== epoch || target !== this.socket) throw new Error("Seatline companion reconnected; the request was interrupted");
      target.send(JSON.stringify(frame));
    });
    return this.outgoing;
  }

  private async ready() {
    if (this.epoch) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.handshake, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("Seatline companion did not complete the handshake")), this.env.connectTimeoutMs ?? 15_000); })]).finally(() => clearTimeout(timer));
    if (!this.epoch) throw new Error("Seatline companion is offline");
  }

  async request(provider: string, method: string, params: unknown, emit: (event: SeatlineEvent) => void, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
    const release = await this.acquire(() => emit({ type: "queued" }), signal);
    return this.requestAdmitted(provider, method, params, emit, release, signal);
  }

  /** Optional preparation never queues and leaves a foreground slot free, including before the first handshake. */
  tryPrepare(provider: string, params: unknown, emit: (event: SeatlineEvent) => void): Promise<boolean> {
    if (this.running >= MAX_RUNNING_REQUESTS - 1 || this.waiting.length > 0) return Promise.resolve(false);
    this.running++;
    return this.requestAdmitted(provider, "prepare", params, emit, this.releaseSlot()).then(() => true);
  }

  private async requestAdmitted(provider: string, method: string, params: unknown, emit: (event: SeatlineEvent) => void, release: () => void, signal?: AbortSignal): Promise<void> {
    try {
      if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
      await this.connect();
      await this.ready();
      if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
      if (this.pending.size >= 32) throw new Error("Seatline request queue is full");
      const id = crypto.randomUUID();
      return await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const item = this.pending.get(id); if (!item) return;
          this.pending.delete(id); item.dispose(); reject(new DOMException("Run cancelled", "AbortError"));
          void this.send({ id: crypto.randomUUID(), method: "cancel", target: id }).catch(() => {});
        };
        const timer = setTimeout(() => { abort(); }, 16 * 60_000);
        const dispose = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); release(); };
        this.pending.set(id, { resolve, reject, emit, dispose });
        signal?.addEventListener("abort", abort, { once: true });
        void this.send({ id, provider, method, params }).catch(error => { this.pending.delete(id); dispose(); reject(error); });
      });
    } finally { release(); }
  }

  disconnect() {
    this.env.storage.removeItem(STORAGE);
    this.socket?.close();
    this.fail(new Error("Seatline pairing disconnected"));
  }

  /** Closes the socket when the page goes away; the companion sees the browser leave. */
  close() { this.socket?.close(); }
}

const seatline = new SeatlineConnection({
  relayUrl,
  openSocket: url => new WebSocket(url),
  get storage() { return sessionStorage; },
  hash: () => location.hash,
  clearFragment: () => history.replaceState(null, "", location.pathname + location.search),
});

/** The companion only exposes neutral Seatline provider operations. */
export class SeatlineClient {
  tryPrepare?: (provider: string, params: unknown, emit: (event: SeatlineEvent) => void) => Promise<boolean> =
    (provider, params, emit) => seatline.tryPrepare(provider, params, emit);
  request(provider: string, method: string, params: unknown, emit: (event: SeatlineEvent) => void, signal?: AbortSignal): Promise<void> {
    return seatline.request(provider, method, params, emit, signal);
  }
}

/**
 * What the app may ask of its companion connection besides requests: when the companion last reconnected (what the app learned about
 * it may no longer hold) and whether a request would have to wait for a running slot. Callers that stand in for it in tests may omit it.
 */
export type SeatlineLink = { generation: () => number; congested: () => boolean };
export const companionLink: SeatlineLink = { generation: () => seatline.generation, congested: () => seatline.congested };

export function disconnectCompanion() { seatline.disconnect(); }

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => seatline.close());
  window.addEventListener("pageshow", event => {if (event.persisted) location.reload();});
}
