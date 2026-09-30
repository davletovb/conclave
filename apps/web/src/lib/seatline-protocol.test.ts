import { describe, expect, it } from "vitest";
import vectors from "../../../../cloudflare/vectors/web-protocol-v2.json";
import {
  dataAad, envelopeSequence, helloAad, importKey, isNonce, newNonce, openFrame, openHello, openWithAad,
  sealFrame, sealHello, sealWithIv, type Epoch,
} from "./seatline-protocol";

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const epoch: Epoch = { helper: "22".repeat(16), browser: "11".repeat(16) };

describe("Seatline web protocol 2 (browser)", () => {
  it("reproduces the published vectors byte for byte, and reads them back", async () => {
    const key = await importKey(fromHex(vectors.key));
    for (const item of vectors.cases) {
      const sealed = await sealWithIv(key, fromBase64(item.iv), item.aad, item.seq, item.plaintext);
      expect(sealed.body, item.name).toBe(item.body);
      expect(await openWithAad(key, item.aad, sealed), item.name).toEqual(JSON.parse(item.plaintext));
      // The documented AAD is what the protocol functions actually build.
      const direction = item.direction as "browser" | "helper";
      expect(item.kind === "hello" ? helloAad(direction) : dataAad(direction, { helper: item.helper_nonce!, browser: item.browser_nonce! }, item.seq), item.name).toBe(item.aad);
    }
  });

  it("opens Seatline's hello and data frames through the protocol functions", async () => {
    const key = await importKey(fromHex(vectors.key));
    const byName = (name: string) => vectors.cases.find(item => item.name === name)!;
    const asEnvelope = (item: typeof vectors.cases[number]) => ({ type: "data" as const, seq: item.seq, iv: item.iv, body: item.body });
    expect(await openHello(key, "browser", asEnvelope(byName("browser hello")))).toEqual({ nonce: "11".repeat(16), echo: null });
    expect(await openHello(key, "helper", asEnvelope(byName("helper hello answering the browser's")))).toEqual({ nonce: "22".repeat(16), echo: "11".repeat(16) });
    expect(await openFrame(key, "browser", epoch, asEnvelope(byName("first browser request")))).toMatchObject({ id: "status", method: "status" });
    expect(await openFrame(key, "helper", epoch, asEnvelope(byName("second helper event")))).toMatchObject({ id: "status", event: { type: "delta" } });
  });

  it("rejects the wrong direction, a changed sequence, another key and any other epoch", async () => {
    const key = await importKey(crypto.getRandomValues(new Uint8Array(32)));
    const other = await importKey(crypto.getRandomValues(new Uint8Array(32)));
    const frame = await sealFrame(key, "browser", epoch, 1, { id: "run", prompt: "Private prompt 🌍" });
    expect(JSON.stringify(frame)).not.toContain("Private prompt");
    expect(await openFrame(key, "browser", epoch, frame)).toMatchObject({ id: "run" });
    await expect(openFrame(key, "helper", epoch, frame)).rejects.toThrow();
    await expect(openFrame(key, "browser", epoch, { ...frame, seq: 2 })).rejects.toThrow();
    await expect(openFrame(other, "browser", epoch, frame)).rejects.toThrow();
    await expect(openFrame(key, "browser", { ...epoch, helper: "33".repeat(16) }, frame)).rejects.toThrow();
    await expect(openFrame(key, "browser", { ...epoch, browser: "33".repeat(16) }, frame)).rejects.toThrow();
    await expect(openFrame(key, "browser", epoch, { ...frame, body: frame.body.slice(0, -4) + "AAAA" })).rejects.toThrow();
  });

  it("keeps hello and data frames apart", async () => {
    const key = await importKey(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = newNonce();
    const hello = await sealHello(key, "browser", nonce);
    expect(hello.seq).toBe(0);
    expect(await openHello(key, "browser", hello)).toEqual({ nonce, echo: null });
    await expect(openHello(key, "helper", hello)).rejects.toThrow();
    expect(() => openFrame(key, "browser", epoch, hello)).toThrow("Invalid sequence");
    const data = await sealFrame(key, "browser", epoch, 1, {});
    await expect(openHello(key, "browser", data)).rejects.toThrow();
  });

  it("validates nonces and sequence numbers before anything is decrypted", () => {
    expect(isNonce(newNonce())).toBe(true);
    for (const bad of ["AA".repeat(16), "aa", "zz".repeat(16), 7, null]) expect(isNonce(bad)).toBe(false);
    expect(envelopeSequence({ seq: 0 })).toBe(0);
    for (const bad of [-1, 1.5, "1", undefined, Number.MAX_SAFE_INTEGER + 2]) expect(() => envelopeSequence({ seq: bad })).toThrow();
  });
});
