import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dataAad, helloAad, importKey, isNonce, newNonce, open, openHello, openWithAad, seal, sealHello, sealWithIv } from "./crypto.mjs";

const vectors = JSON.parse(readFileSync(new URL("./vectors/web-protocol-v2.json", import.meta.url), "utf8"));
const epoch = { helper: "22".repeat(16), browser: "11".repeat(16) };

test("reproduces the published Seatline vectors byte for byte and reads them back", async () => {
  const key = await importKey(Buffer.from(vectors.key, "hex"));
  for (const item of vectors.cases) {
    const sealed = await sealWithIv(key, Buffer.from(item.iv, "base64"), item.aad, item.seq, item.plaintext);
    assert.equal(sealed.body, item.body, item.name);
    assert.deepEqual(await openWithAad(key, item.aad, sealed), JSON.parse(item.plaintext), item.name);
    const expected = item.kind === "hello" ? helloAad(item.direction) : dataAad(item.direction, { helper: item.helper_nonce, browser: item.browser_nonce }, item.seq);
    assert.equal(expected, item.aad, item.name);
  }
});

test("frames reject the wrong direction, a changed sequence, another key and any other epoch", async () => {
  const key = await importKey(crypto.getRandomValues(new Uint8Array(32)));
  const other = await importKey(crypto.getRandomValues(new Uint8Array(32)));
  const value = { id: "run-1", type: "request", body: "Private prompt 🌍" };
  const sealed = await seal(key, "browser", epoch, 1, value);
  assert.deepEqual(await open(key, "browser", epoch, sealed), value);
  assert.ok(!JSON.stringify(sealed).includes("Private prompt"));
  await assert.rejects(open(key, "helper", epoch, sealed));
  await assert.rejects(open(other, "browser", epoch, sealed));
  await assert.rejects(open(key, "browser", epoch, { ...sealed, seq: 2 }));
  await assert.rejects(open(key, "browser", { ...epoch, helper: "33".repeat(16) }, sealed));
  await assert.rejects(open(key, "browser", { ...epoch, browser: "33".repeat(16) }, sealed));
  await assert.rejects(open(key, "browser", epoch, { ...sealed, body: sealed.body.slice(0, -4) + "AAAA" }));
});

test("a hello is authenticated and cannot pass for data or for the other direction", async () => {
  const key = await importKey(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = newNonce();
  assert.ok(isNonce(nonce));
  const hello = await sealHello(key, "browser", nonce);
  assert.equal(hello.seq, 0);
  assert.equal((await openHello(key, "browser", hello)).nonce, nonce);
  await assert.rejects(openHello(key, "helper", hello));
  await assert.rejects(async () => open(key, "browser", epoch, hello));
  await assert.rejects(openHello(key, "browser", await seal(key, "browser", epoch, 1, {})));
});
