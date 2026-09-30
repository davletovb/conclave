type Pair = { id: string; token: string; key: string; sent: number; received: number };
export type SeatlineEvent = { type: string; text?: string; reason?: string; status?: { availability: string; authentication: string; sign_in?: string; models: Array<{id:string;label:string}> }; usage?: {input_tokens?:number;output_tokens?:number} };
type Packet = {id: string; event: SeatlineEvent};
type Pending = { resolve: () => void; reject: (error: Error) => void; emit: (event: SeatlineEvent) => void; dispose: () => void };
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
  for (const item of pending.values()) { item.dispose(); item.reject(error); }
  pending.clear(); connected = undefined;
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
    current.onmessage = message => {
      if (typeof message.data !== "string" || message.data.length > 768 * 1024 || ++inbound > 128) { current.close(1008); inbound--; return; }
      incoming = incoming.then(async () => {
        if (current !== socket) return;
        const envelope = JSON.parse(message.data);
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
        if (!packet.event || typeof packet.event.type !== "string") throw new Error("Invalid companion provider event");
        const event = packet.event;
        if (["completed","failed","stopped"].includes(event.type)) {
          pending.delete(packet.id); item.dispose();
          if (event.type === "completed") item.resolve();
          else { const error = new Error(event.type === "stopped" ? "Run cancelled" : event.reason ?? "Provider failed"); if (event.type === "stopped") error.name = "AbortError"; item.reject(error); }
        } else {
          try {item.emit(event);} catch (error) {
            pending.delete(packet.id); item.dispose(); item.reject(error instanceof Error ? error : new Error("Provider event rejected"));
            void send({id:crypto.randomUUID(),method:"cancel",target:packet.id}).catch(() => {});
          }
        }
      }).catch(() => { fail(new Error("Invalid encrypted companion response")); current.close(1008); }).finally(() => inbound--);
    };
    current.onclose = () => { clearTimeout(timer); if (!settled) reject(new Error("Seatline companion is unavailable or pairing expired")); if (current === socket) fail(new Error("Seatline connection closed")); };
    current.onerror = () => current.close();
  });
  return connected;
}

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

/** The companion only exposes neutral Seatline provider operations. */
export class SeatlineClient {
  async request(provider: string, method: string, params: unknown, emit: (event: SeatlineEvent) => void, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
    await connect();
    if (signal?.aborted) throw new DOMException("Run cancelled", "AbortError");
    if (pending.size >= 32) throw new Error("Seatline request queue is full");
    const id = crypto.randomUUID();
    return new Promise<void>((resolve,reject) => {
      const abort = () => {
        const item = pending.get(id); if (!item) return;
        pending.delete(id); item.dispose(); reject(new DOMException("Run cancelled", "AbortError"));
        void send({id:crypto.randomUUID(),method:"cancel",target:id}).catch(() => {});
      };
      const timer = setTimeout(() => {abort();},16*60_000);
      const dispose = () => {clearTimeout(timer);signal?.removeEventListener("abort",abort);};
      pending.set(id,{resolve,reject,emit,dispose});
      signal?.addEventListener("abort",abort,{once:true});
      void send({id,provider,method,params}).catch(error => {pending.delete(id);dispose();reject(error);});
    });
  }
}

export function disconnectCompanion() {
  sessionStorage.removeItem(STORAGE); socket?.close(); fail(new Error("Seatline pairing disconnected"));
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => socket?.close());
  window.addEventListener("pageshow", event => {if (event.persisted) location.reload();});
}
