import { envelopeSequence, importKey, newNonce, openFrame, openHello, sealFrame, sealHello, type Envelope, type Epoch } from "./seatline-protocol";

/** A pairing: the relay channel, the browser's credential and the key. `relay` is the relay origin it was made at. */
type Pair = { id: string; token: string; key: string; relay?: string };
const validPair = (pair: Partial<Pair> | null | undefined): pair is Pair =>
  /^[a-f0-9]{64}$/.test(pair?.id ?? "") && /^[a-f0-9]{64}$/.test(pair?.token ?? "") && /^[a-zA-Z0-9_-]{43}$/.test(pair?.key ?? "")
  && (pair?.relay === undefined || typeof pair.relay === "string");

/**
 * Where this tab stands with Seatline, for the app to show: no pairing yet (or it lapsed), connecting, the relay reached but
 * Seatline not there, connected, or unreachable for another reason.
 */
export type CompanionState =
  | { kind: "unpaired"; message?: string }
  | { kind: "connecting" }
  | { kind: "waiting" }
  | { kind: "connected" }
  | { kind: "unavailable"; message: string };

/** The close code the relay gives a browser for a pairing it no longer has (cloudflare/worker.mjs). */
const PAIRING_GONE = 4410;
const PAIRING_EXPIRED = "Your Seatline pairing has expired. Connect Seatline again.";
const NOT_PAIRED = "This browser is not connected to Seatline yet. Use Connect Seatline.";
/** What Seatline's connect page posts to the window that opened it (`companion/src/connect.rs` in Seatline). */
const PAIRING_MESSAGE = "seatline-pairing";
export const DEFAULT_LOCAL_PORT = 27183;
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
  /** Where the pairing is kept. It outlives the tab, so the site stays connected after a reload or a restart. */
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** location.hash, which carries the pairing link the first time the page opens. */
  hash: () => string;
  /** Removes the pairing link from the address bar. */
  clearFragment: () => void;
  /** How long to wait for the companion to appear and answer the handshake. */
  connectTimeoutMs?: number;
  /** How often a request waiting for a free slot says so, so the caller can tell it is not stuck. */
  queueNoticeMs?: number;
  /** This website's origin, which Seatline hands a pairing to. */
  origin?: string;
  /** The app name Seatline authorized this website under. */
  app?: string;
  /** The loopback port of Seatline's web service. */
  localPort?: number;
  /** Opens Seatline's connect page in a window of its own. Called within the user's click, or the browser blocks it. */
  openWindow?: (url: string) => { closed: boolean; close: () => void } | null;
  /** Listens for messages posted to this window, until the returned function is called. */
  listen?: (listener: (event: { origin: string; source: unknown; data: unknown }) => void) => () => void;
  /** How long the connect page has to hand over a pairing. */
  pairTimeoutMs?: number;
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
  private current: CompanionState | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly env: SeatlineEnvironment) {}

  /** Where this tab stands with Seatline. Before anything was tried: connecting when a pairing is kept, unpaired otherwise. */
  get state(): CompanionState {
    return this.current ??= this.hasPairing() ? { kind: "connecting" } : { kind: "unpaired" };
  }

  /** Calls `listener` whenever the state changes, until the returned function is called. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private setState(next: CompanionState) {
    const previous = this.current;
    if (previous?.kind === next.kind && (previous as { message?: string }).message === (next as { message?: string }).message) return;
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** The relay origin this site's pairings are made at. */
  private relayOrigin(): string | undefined {
    try { return this.env.relayUrl ? new URL(this.env.relayUrl).origin : undefined; } catch { return undefined; }
  }

  private hasPairing() {
    try { return new URLSearchParams(this.env.hash().slice(1)).has("seatline") || Boolean(this.env.storage.getItem(STORAGE)); }
    catch { return false; }
  }

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
      const linked = { id, token, key, relay: this.relayOrigin() };
      if (!validPair(linked)) throw new Error("Invalid Seatline pairing link");
      storage.setItem(STORAGE, JSON.stringify(linked));
      storage.removeItem(LEGACY_STORAGE);
    }
    const saved = storage.getItem(STORAGE);
    if (!saved) { this.setState({ kind: "unpaired" }); throw new Error(NOT_PAIRED); }
    let pair: Pair | undefined;
    try { pair = JSON.parse(saved); } catch { pair = undefined; }
    // A pairing made at another relay (the site moved) cannot work here.
    if (!validPair(pair) || (pair.relay !== undefined && pair.relay !== this.relayOrigin())) {
      storage.removeItem(STORAGE);
      this.setState({ kind: "unpaired" });
      throw new Error(NOT_PAIRED);
    }
    return pair;
  }

  /**
   * Gets this website's pairing from Seatline on this computer: opens Seatline's connect page in a window of its own, which posts
   * the pairing back to this window and closes. Must be called within the user's click: the window is opened before anything is
   * awaited. Chrome lets a website open such a window without its local network prompt; Safari opens it too.
   */
  pairLocally(): Promise<void> {
    const relay = this.relayOrigin();
    const { origin, openWindow, listen } = this.env;
    if (!relay || !origin || !openWindow || !listen) return Promise.reject(new Error("This build cannot connect to Seatline on this computer."));
    const local = `http://127.0.0.1:${this.env.localPort ?? DEFAULT_LOCAL_PORT}`;
    const url = `${local}/connect?${new URLSearchParams({ app: this.env.app ?? "conclave", origin, relay })}`;
    const popup = openWindow(url);
    if (!popup) return Promise.reject(new Error("The browser blocked Seatline's window. Allow pop-ups for this site, then try again."));
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer); clearInterval(watch); stop();
        try { popup.close(); } catch { /* already closed */ }
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error("Seatline did not answer. Make sure Seatline is installed and running on this computer, then try again.")), this.env.pairTimeoutMs ?? 20_000);
      // Closing the window by hand is an answer too.
      const watch = setInterval(() => { if (popup.closed) finish(new Error("The Seatline window was closed before it connected.")); }, 500);
      const stop = listen(event => {
        if (event.origin !== local || event.source !== popup) return;
        const data = event.data as Partial<Pair> & { type?: unknown; version?: unknown; error?: unknown; message?: unknown } | null;
        if (!data || data.type !== PAIRING_MESSAGE || data.version !== 1) return;
        if (typeof data.error === "string") { finish(new Error(typeof data.message === "string" ? data.message : "Seatline could not connect this site.")); return; }
        const pair = { id: data.id, token: data.token, key: data.key, relay: data.relay };
        if (!validPair(pair) || pair.relay !== relay) { finish(new Error("Seatline sent a pairing this site cannot use.")); return; }
        this.adopt(pair);
        finish();
      });
    });
  }

  /** Keeps `pair` and starts over with it: whatever ran under the previous one is interrupted. */
  private adopt(pair: Pair) {
    this.env.storage.setItem(STORAGE, JSON.stringify(pair));
    this.env.storage.removeItem(LEGACY_STORAGE);
    const previous = this.socket; this.socket = undefined;
    this.fail(new Error("Seatline pairing changed; the request was interrupted"));
    previous?.close();
    this.setState({ kind: "connecting" });
    void this.connect().catch(() => {});
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
    this.setState({ kind: "connecting" });
    this.connected = new Promise<void>((resolve, reject) => {
      let settled = false;
      // The relay said Seatline is not connected to it: not running on this computer, or unable to reach the relay.
      let absent = false;
      let failure: Error | undefined;
      const settle = () => { clearTimeout(timer); settled = true; this.setState({ kind: "connected" }); resolve(); };
      const timer = setTimeout(() => {
        failure = new Error(absent
          ? "Seatline isn't answering from this computer. Make sure it is running (seatline-companion web), then retry."
          : "Seatline did not answer. Update Seatline on this computer (it must speak web protocol 2), then retry.");
        reject(failure); current.close();
      }, this.env.connectTimeoutMs ?? 15_000);
      current.onopen = () => current.send(JSON.stringify({ type: "auth", token: pair.token }));
      current.onmessage = message => {
        if (typeof message.data !== "string" || message.data.length > 768 * 1024 || ++this.inbound > 128) { current.close(1008); this.inbound--; return; }
        this.incoming = this.incoming.then(async () => {
          if (current !== this.socket) return;
          const envelope = JSON.parse(message.data);
          if (envelope.type === "ready" || envelope.type === "peer") {
            const peer = envelope.peer === true || envelope.connected === true;
            if (!peer) {
              this.epoch = undefined; absent = true;
              if (settled) { this.fail(new Error("Seatline companion disconnected")); current.close(); }
              else this.setState({ kind: "waiting" });
              return;
            }
            absent = false;
            // The companion is (re)connected: what ran before it is gone, and a new epoch begins.
            this.interrupt(new Error("Seatline companion reconnected; the request was interrupted"));
            await this.beginHandshake(current);
            return;
          }
          if (envelope.type === "pong") return;
          if (envelope.type !== "data") return;
          await this.onFrame(envelope, settle);
        }).catch(error => {
          const broken = error instanceof ProtocolError ? error : new Error("Invalid encrypted companion response");
          failure ??= broken;
          this.fail(broken);
          // Before the handshake finished, the caller is waiting on this promise and should hear why, not
          // the generic close that follows.
          if (!settled) reject(broken);
          current.close(1008);
        }).finally(() => this.inbound--);
      };
      current.onclose = (event?: { code?: number; reason?: string }) => {
        clearTimeout(timer);
        // The relay no longer has this pairing: keeping it would only fail again.
        const gone = event?.code === PAIRING_GONE || (event?.code === 1008 && event.reason === "Pairing expired");
        if (gone && this.env.storage.getItem(STORAGE)?.includes(pair.id)) this.env.storage.removeItem(STORAGE);
        const error = failure ?? new Error(gone ? PAIRING_EXPIRED
          : settled ? "Seatline connection closed" : "Can't reach the Seatline relay. Check your connection, then retry.");
        if (!settled) reject(error);
        if (current !== this.socket) return;
        this.fail(error);
        this.setState(gone ? { kind: "unpaired", message: PAIRING_EXPIRED }
          : event?.code === 1000 && event.reason === "Replaced" ? { kind: "unavailable", message: "Conclave connected to Seatline from another window." }
          : settled && absent ? { kind: "unavailable", message: "Seatline on this computer went offline. Retry once it is running." }
          : settled ? { kind: "unavailable", message: "The connection to Seatline was interrupted. Retry to reconnect." }
          : { kind: "unavailable", message: error.message });
      };
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

  /** Forgets this browser's pairing. Seatline keeps the website's; connecting again hands the same one back. */
  disconnect() {
    this.env.storage.removeItem(STORAGE);
    const socket = this.socket; this.socket = undefined;
    this.fail(new Error("Seatline pairing disconnected"));
    socket?.close();
    this.setState({ kind: "unpaired" });
  }

  /** Closes the socket when the page goes away; the companion sees the browser leave. */
  close() { this.socket?.close(); }
}

const localPort = Number(import.meta.env.VITE_SEATLINE_LOCAL_PORT) || DEFAULT_LOCAL_PORT;
const app = (import.meta.env.VITE_SEATLINE_APP as string | undefined) || "conclave";

// Pairings used to live in the tab's session storage, so every new tab had to pair again. Keep one made that way.
if (typeof window !== "undefined") {
  try {
    const earlier = sessionStorage.getItem(STORAGE);
    if (earlier && !localStorage.getItem(STORAGE)) localStorage.setItem(STORAGE, earlier);
    sessionStorage.removeItem(STORAGE); sessionStorage.removeItem(LEGACY_STORAGE);
  } catch { /* storage unavailable: nothing to keep */ }
}

const seatline = new SeatlineConnection({
  relayUrl,
  openSocket: url => new WebSocket(url),
  get storage() { return localStorage; },
  hash: () => location.hash,
  clearFragment: () => history.replaceState(null, "", location.pathname + location.search),
  get origin() { return typeof location === "undefined" ? undefined : location.origin; },
  app,
  localPort,
  openWindow: url => window.open(url, "seatline-connect", "popup,width=480,height=560"),
  listen: listener => {
    const handle = (event: MessageEvent) => listener(event);
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  },
});

/** What someone setting up Seatline for this site needs to know. */
export const companionSetup = {
  app,
  localPort,
  get origin() { return typeof location === "undefined" ? "" : location.origin; },
  relay: (() => { try { return relayUrl ? new URL(relayUrl).origin : ""; } catch { return ""; } })(),
};

export const companionState = () => seatline.state;
export const subscribeCompanion = (listener: () => void) => seatline.subscribe(listener);
/** Connects this browser to Seatline on this computer. Call it from the user's click. */
export const connectCompanion = () => seatline.pairLocally();

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
