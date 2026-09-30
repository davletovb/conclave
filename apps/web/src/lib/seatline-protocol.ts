// Web transport protocol 2, the browser half. The specification is
// companion/src/secure.rs in davletovb/seatline, and cloudflare/vectors/web-protocol-v2.json
// (produced by an independent AES-GCM implementation) fixes the exact bytes.
//
// The relay is not trusted. Every frame is AES-256-GCM under the pairing key and is bound to its
// direction, the epoch (a fresh browser nonce plus a fresh helper nonce, agreed in a handshake) and
// its sequence number, so a dropped, repeated, reordered or replayed frame cannot go unnoticed.
const encoder = new TextEncoder();
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

export type Direction = "browser" | "helper";
/** Nonces are 16 random bytes in lowercase hex. */
export type Epoch = { helper: string; browser: string };
export type Envelope = { type: "data"; seq: number; iv: string; body: string };

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
const fromBase64 = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

export const isNonce = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
export const newNonce = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

export const importKey = (bytes: Uint8Array) => crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);

export const helloAad = (direction: Direction) => `seatline:2:hello:${direction}`;
export const dataAad = (direction: Direction, epoch: Epoch, seq: number) => `seatline:2:${direction}:${epoch.helper}:${epoch.browser}:${seq}`;

/** Seals exact plaintext bytes with a chosen IV. Only tests choose the IV. */
export async function sealWithIv(key: CryptoKey, iv: Uint8Array, aad: string, seq: number, plaintext: string): Promise<Envelope> {
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: encoder.encode(aad) }, key, encoder.encode(plaintext));
  return { type: "data", seq, iv: toBase64(iv), body: toBase64(new Uint8Array(body)) };
}
const seal = (key: CryptoKey, aad: string, seq: number, value: unknown) =>
  sealWithIv(key, crypto.getRandomValues(new Uint8Array(12)), aad, seq, JSON.stringify(value));

export async function openWithAad(key: CryptoKey, aad: string, envelope: Envelope): Promise<unknown> {
  if (typeof envelope.iv !== "string" || typeof envelope.body !== "string") throw new Error("Invalid encrypted envelope");
  const iv = fromBase64(envelope.iv);
  if (iv.length !== 12) throw new Error("Invalid IV");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: encoder.encode(aad) }, key, fromBase64(envelope.body) as BufferSource);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
}

/** The sequence number an envelope claims, checked before anything is decrypted. */
export function envelopeSequence(envelope: { seq?: unknown }): number {
  const seq = envelope.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seq > MAX_SEQUENCE) throw new Error("Invalid sequence");
  return seq;
}

export const sealHello = (key: CryptoKey, direction: Direction, nonce: string, echo: string | null = null) =>
  seal(key, helloAad(direction), 0, { type: "hello", nonce, echo });

export async function openHello(key: CryptoKey, direction: Direction, envelope: Envelope): Promise<{ nonce: string; echo: string | null }> {
  if (envelopeSequence(envelope) !== 0) throw new Error("Not a hello");
  const hello = await openWithAad(key, helloAad(direction), envelope) as { type?: unknown; nonce?: unknown; echo?: unknown };
  if (hello.type !== "hello" || !isNonce(hello.nonce) || !(hello.echo === null || isNonce(hello.echo))) throw new Error("Invalid hello");
  return { nonce: hello.nonce, echo: hello.echo };
}

export function sealFrame(key: CryptoKey, direction: Direction, epoch: Epoch, seq: number, value: unknown) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Invalid sequence");
  return seal(key, dataAad(direction, epoch, seq), seq, value);
}

export function openFrame(key: CryptoKey, direction: Direction, epoch: Epoch, envelope: Envelope): Promise<unknown> {
  const seq = envelopeSequence(envelope);
  if (seq < 1) throw new Error("Invalid sequence");
  return openWithAad(key, dataAad(direction, epoch, seq), envelope);
}
