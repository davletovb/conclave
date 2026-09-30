import assert from "node:assert/strict";
import test from "node:test";
import worker, { Channel } from "./worker.mjs";

const approved = "https://conclave.test";
const pair = { origin: approved, credentials: { helper: "a".repeat(64), browser: "b".repeat(64) }, expires: Date.now() + 60_000 };
const request = body => new Request("https://relay.test/pair", { method: "POST", body: JSON.stringify(body) });

test("pairing admits only configured app origins and bounds chunked bodies", async () => {
  let created = 0;
  const env = { APP_ORIGINS: JSON.stringify({ conclave: [approved] }), CHANNELS: {
    idFromName: id => id,
    get: () => ({ async fetch(input) { created++; const saved = await input.json(); assert.equal(saved.origin, approved); return new Response("Created"); } }),
  } };
  assert.equal((await worker.fetch(request(null), env)).status, 400);
  assert.equal((await worker.fetch(request({ app: "conclave", origin: "https://other.test" }), env)).status, 403);
  assert.equal((await worker.fetch(request({ app: "other", origin: approved }), env)).status, 403);
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2049)); controller.close(); } });
  assert.equal((await worker.fetch(new Request("https://relay.test/pair", { method: "POST", body, duplex: "half" }), env)).status, 413);
  assert.equal(created, 0);
  const response = await worker.fetch(request({ app: "conclave", origin: approved }), env);
  const credentials = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(created, 1);
  for (const value of Object.values(credentials)) assert.match(value, /^[a-f0-9]{64}$/);
  assert.notEqual(credentials.helper, credentials.browser);
});

function socket(role) {
  let attachment = { role, authorized: false, opened: Date.now(), bytes: 0, window: Date.now() };
  return { readyState: 1, sent: [], closed: undefined,
    deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment: value => { attachment = structuredClone(value); },
    send(value) { this.sent.push(value); },
    close(code, reason) { this.readyState = 3; this.closed = { code, reason }; },
  };
}

function channel(sockets, saved = pair) {
  return new Channel({
    storage: { get: async () => saved, setAlarm: async () => {}, deleteAll: async () => {} },
    getWebSockets: role => sockets.filter(ws => ws.readyState === 1 && (!role || ws.deserializeAttachment().role === role)),
  });
}

test("channel checks browser origin, role credentials, and pairing expiry", async () => {
  const browser = socket("browser"); const relay = channel([browser]);
  assert.equal((await relay.fetch(new Request("https://relay.test/channels/id/browser", { headers: { origin: "https://other.test" } }))).status, 403);
  await relay.webSocketMessage(browser, JSON.stringify({ type: "auth", token: pair.credentials.helper }));
  assert.equal(browser.closed.code, 1008);
  const expired = socket("helper");
  await channel([expired], { ...pair, expires: 0 }).webSocketMessage(expired, JSON.stringify({ type: "auth", token: pair.credentials.helper }));
  assert.equal(expired.closed.reason, "Pairing expired");
});

test("authenticated relay forwards opaque ciphertext and bounds message traffic", async () => {
  const helper = socket("helper"); const browser = socket("browser"); const relay = channel([helper, browser]);
  await relay.webSocketMessage(helper, JSON.stringify({ type: "auth", token: pair.credentials.helper }));
  await relay.webSocketMessage(browser, JSON.stringify({ type: "auth", token: pair.credentials.browser }));
  const envelope = JSON.stringify({ type: "data", seq: 1, iv: "opaque-iv", body: "opaque-ciphertext" });
  await relay.webSocketMessage(browser, envelope);
  assert.equal(helper.sent.at(-1), envelope);
  await relay.webSocketMessage(browser, "x".repeat(768 * 1024 + 1));
  assert.equal(browser.closed.code, 1009);
});
