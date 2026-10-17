import assert from "node:assert/strict";
import test from "node:test";
import site from "../apps/web/public/_worker.js";

const recorder = name => {
  const seen = [];
  return { seen, fetch: async request => (seen.push(request), new Response(name)) };
};

test("the site forwards only relay paths to the relay and serves the rest as files", async () => {
  const env = { ASSETS: recorder("asset"), RELAY: recorder("relay") };
  const channel = `/channels/${"a".repeat(64)}/browser`;
  for (const path of ["/pair", channel]) {
    const request = new Request(`https://conclave.test${path}`, { headers: { origin: "https://conclave.test", "cf-connecting-ip": "203.0.113.1" } });
    assert.equal(await (await site.fetch(request, env)).text(), "relay");
    assert.equal(env.RELAY.seen.at(-1), request, "the original request, headers and all, reaches the relay");
  }
  for (const path of ["/", "/index.html", "/assets/app.js", "/pairing", "/channels"]) {
    assert.equal(await (await site.fetch(new Request(`https://conclave.test${path}`), env)).text(), "asset", path);
  }
  assert.equal(env.RELAY.seen.length, 2);
});

test("a site without the relay binding says so instead of serving index.html", async () => {
  const response = await site.fetch(new Request("https://conclave.test/pair", { method: "POST" }), { ASSETS: recorder("asset") });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /RELAY service binding/);
});
