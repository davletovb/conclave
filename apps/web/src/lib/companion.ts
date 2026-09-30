type Pair = { id: string; token: string; key: string; sent: number; received: number };
type Packet = { id: string; type: string; status?: number; headers?: Record<string, string>; data?: string };
type Pending = { resolve: (response: Response) => void; reject: (error: Error) => void; controller: ReadableStreamDefaultController<Uint8Array>; dispose: () => void; headed: boolean };
const STORAGE = "conclave.seatline.pair.v1";
const relayUrl = import.meta.env.VITE_SEATLINE_RELAY as string | undefined;
export const usesCompanion = Boolean(relayUrl) || !import.meta.env.DEV;
let socket: WebSocket | undefined;
let connected: Promise<void> | undefined;
let peerReady = false;
let outgoing = Promise.resolve();
let incoming = Promise.resolve();
let inbound = 0;
const pending = new Map<string, Pending>();
const from64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const to64 = (bytes: Uint8Array) => {
  let text = ""; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};

function pairing(): Pair {
  const fragment = new URLSearchParams(location.hash.slice(1)).get("seatline");
  if (fragment) {
    const [id, token, key] = fragment.split(":");
    history.replaceState(null, "", location.pathname + location.search);
    if (!/^[a-f0-9]{64}$/.test(id ?? "") || !/^[a-f0-9]{64}$/.test(token ?? "") || !/^[a-zA-Z0-9_-]{43}$/.test(key ?? "")) throw new Error("Invalid Seatline pairing link");
    sessionStorage.setItem(STORAGE, JSON.stringify({ id, token, key, sent: 0, received: 0 }));
  }
  const saved = sessionStorage.getItem(STORAGE);
  if (!saved) throw new Error("Open Conclave from the Seatline companion to connect this browser.");
  const pair: Pair = JSON.parse(saved);
  if (!/^[a-f0-9]{64}$/.test(pair.id) || !/^[a-f0-9]{64}$/.test(pair.token) || !/^[a-zA-Z0-9_-]{43}$/.test(pair.key)
    || !Number.isSafeInteger(pair.sent) || pair.sent < 0 || !Number.isSafeInteger(pair.received) || pair.received < 0) throw new Error("Invalid saved Seatline pairing");
  return pair;
}

function fail(error: Error) {
  peerReady = false;
  for (const item of pending.values()) { item.dispose(); if (item.headed) item.controller.error(error); else item.reject(error); }
  pending.clear(); streams.clear(); connected = undefined;
}

async function connect() {
  if (connected && socket?.readyState === WebSocket.OPEN && peerReady) return connected;
  if (connected) return connected;
  if (!relayUrl) throw new Error("The hosted website needs a configured Seatline relay.");
  const relay = new URL(relayUrl);
  if (relay.protocol !== "https:") throw new Error("Seatline relay must use HTTPS");
  const pair = pairing();
  const endpoint = new URL(`/channels/${pair.id}/browser`, relay); endpoint.protocol = "wss:";
  const key = await crypto.subtle.importKey("raw", from64(pair.key), "AES-GCM", false, ["encrypt", "decrypt"]);
  // Share connection creation across concurrent catalogue/bootstrap requests.
  if (connected) return connected;
  const current = new WebSocket(endpoint); socket = current;
  connected = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { reject(new Error("Seatline companion is offline. Open the companion and try again.")); current.close(); }, 15_000);
    current.onopen = () => current.send(JSON.stringify({ type: "auth", token: pair.token }));
    current.onmessage = event => {
      if (typeof event.data !== "string" || event.data.length > 768 * 1024 || ++inbound > 128) { current.close(1008); inbound--; return; }
      incoming = incoming.then(async () => {
        if (current !== socket) return;
        const envelope = JSON.parse(event.data);
        if (envelope.type === "ready" || envelope.type === "peer") {
          peerReady = envelope.peer === true || envelope.connected === true;
          if (peerReady) { clearTimeout(timer); settled = true; resolve(); }
          else if (settled) { fail(new Error("Seatline companion disconnected")); current.close(); }
          return;
        }
        if (envelope.type === "pong") return;
        if (envelope.type !== "data" || !Number.isSafeInteger(envelope.seq) || envelope.seq <= pair.received) return;
        const aad = new TextEncoder().encode(`seatline:1:helper:${envelope.seq}`);
        const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: from64(envelope.iv), additionalData: aad }, key, from64(envelope.body));
        const packet: Packet = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
        pair.received = envelope.seq; const saved = pairing(); saved.received = envelope.seq; sessionStorage.setItem(STORAGE, JSON.stringify(saved));
        const item = pending.get(packet.id); if (!item) return;
        if (packet.type === "head" && !item.headed) {
          if (!Number.isInteger(packet.status) || packet.status! < 200 || packet.status! > 599) throw new Error("Invalid companion status");
          item.headed = true;
          // The stream is created by companionFetch and attached below.
          item.resolve(new Response(streams.get(packet.id)!, { status: packet.status, headers: packet.headers }));
        } else if (packet.type === "chunk" && item.headed && typeof packet.data === "string") {
          const bytes = from64(packet.data);
          if (bytes.length > 16384 || (item.controller.desiredSize ?? 0) < -4 * 1024 * 1024) throw new Error("Companion stream queue is full");
          item.controller.enqueue(bytes);
        } else if (packet.type === "end") {
          pending.delete(packet.id); streams.delete(packet.id); item.dispose();
          if (item.headed) item.controller.close(); else item.reject(new Error("Companion response ended without headers"));
        } else { throw new Error("Invalid companion response order"); }
      }).catch(() => { fail(new Error("Invalid encrypted companion response")); current.close(1008); }).finally(() => inbound--);
    };
    current.onclose = () => { clearTimeout(timer); if (!settled) reject(new Error("Seatline companion is unavailable or pairing expired")); if (current === socket) fail(new Error("Seatline connection closed")); };
    current.onerror = () => current.close();
  });
  return connected;
}
const streams = new Map<string, ReadableStream<Uint8Array>>();

async function send(value: unknown) {
  const target = socket;
  const pair = pairing();
  const key = await crypto.subtle.importKey("raw", from64(pair.key), "AES-GCM", false, ["encrypt"]);
  outgoing = outgoing.catch(() => {}).then(async () => {
    if (!target || target !== socket || target.readyState !== WebSocket.OPEN || !peerReady) throw new Error("Seatline companion is offline");
    const clear = new TextEncoder().encode(JSON.stringify(value));
    if (clear.length > 512 * 1024 || target.bufferedAmount > 2 * 1024 * 1024) throw new Error("Seatline request queue is full");
    const saved = pairing();
    const seq = ++saved.sent;
    // Save before sending so reconnect/reload cannot replay a mutating request.
    sessionStorage.setItem(STORAGE, JSON.stringify(saved));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(`seatline:1:browser:${seq}`);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, clear);
    target.send(JSON.stringify({ type: "data", seq, iv: to64(iv), body: to64(new Uint8Array(ciphertext)) }));
  });
  return outgoing;
}

export async function companionFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  await connect();
  if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  if (pending.size >= 32) throw new Error("Seatline request queue is full");
  const id = crypto.randomUUID();
  return new Promise<Response>((resolve, reject) => {
    const abort = () => {
      const item = pending.get(id); if (!item) return;
      pending.delete(id); streams.delete(id); item.dispose();
      const error = new DOMException("Request aborted", "AbortError");
      if (item.headed) item.controller.error(error); else reject(error);
      void send({ id, type: "abort" }).catch(() => {});
    };
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel: abort }, { highWaterMark: 1024 * 1024, size: bytes => bytes.length });
    const timer = setTimeout(() => { if (!pending.get(id)?.headed) { abort(); reject(new Error("Seatline request timed out")); } }, 60_000);
    const dispose = () => { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); };
    streams.set(id, stream); pending.set(id, { resolve, reject, controller, dispose, headed: false });
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") { abort(); reject(new Error("Companion requests require a JSON body")); return; }
    void send({ id, type: "request", path, method: init.method ?? "GET", body: init.body }).catch(error => {
      pending.delete(id); streams.delete(id); dispose(); reject(error);
    });
  });
}

export function disconnectCompanion() {
  sessionStorage.removeItem(STORAGE); socket?.close(); fail(new Error("Seatline pairing disconnected"));
}
