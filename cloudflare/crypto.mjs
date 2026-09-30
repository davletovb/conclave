// Web transport protocol 2 for Node: the reference used by the relay tests and the native round trip.
// The specification is companion/src/secure.rs in davletovb/seatline, and vectors/web-protocol-v2.json
// (produced by an independent AES-GCM implementation) fixes the exact bytes. The browser's copy is
// apps/web/src/lib/seatline-protocol.ts; both are tested against the same vectors.
const encoder = new TextEncoder();
const b64 = bytes => Buffer.from(bytes).toString("base64");
export const newNonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
export const isNonce = value => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
export async function importKey(bytes) {
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealWithIv(key, iv, aad, seq, plaintext) {
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, key, encoder.encode(plaintext));
  return { type: "data", seq, iv: b64(iv), body: b64(body) };
}
const sealRaw = (key, aad, seq, value) => sealWithIv(key, crypto.getRandomValues(new Uint8Array(12)), aad, seq, JSON.stringify(value));
export async function openWithAad(key, aad, envelope) {
  if (typeof envelope.iv !== "string" || typeof envelope.body !== "string") throw new Error("Invalid encrypted envelope");
  const iv = Buffer.from(envelope.iv, "base64");
  if (iv.length !== 12) throw new Error("Invalid IV");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, key, Buffer.from(envelope.body, "base64"));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
}
export function envelopeSequence(envelope) {
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 0) throw new Error("Invalid sequence");
  return envelope.seq;
}
export const helloAad = direction => `seatline:2:hello:${direction}`;
export const dataAad = (direction, epoch, seq) => `seatline:2:${direction}:${epoch.helper}:${epoch.browser}:${seq}`;
export const sealHello = (key, direction, nonce, echo = null) => sealRaw(key, helloAad(direction), 0, { type: "hello", nonce, echo });
export async function openHello(key, direction, envelope) {
  if (envelopeSequence(envelope) !== 0) throw new Error("Not a hello");
  const hello = await openWithAad(key, helloAad(direction), envelope);
  if (hello.type !== "hello" || !isNonce(hello.nonce) || !(hello.echo === null || isNonce(hello.echo))) throw new Error("Invalid hello");
  return hello;
}
export function seal(key, direction, epoch, seq, value) {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Invalid sequence");
  return sealRaw(key, dataAad(direction, epoch, seq), seq, value);
}
export function open(key, direction, epoch, envelope) {
  if (envelopeSequence(envelope) < 1) throw new Error("Invalid sequence");
  return openWithAad(key, dataAad(direction, epoch, envelope.seq), envelope);
}
