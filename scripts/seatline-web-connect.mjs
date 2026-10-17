// Integration test tooling only: production Seatline and its transport are Rust.
//
// The background web service, `seatline-companion web`, against a stand-in relay: the website asks
// Seatline's loopback connect page for its pairing (as Conclave's Connect button does), receives the
// standing pairing addressed to its own origin, and uses it over the encrypted relay. The page refuses
// what a browser would send from anywhere but a window of its own, and from an unauthorized website.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { createServer as createPlainServer } from "node:net";
import { request as httpRequest } from "node:http";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { importKey, seal, open, sealHello, openHello, newNonce } from "../cloudflare/crypto.mjs";

const executable = resolve(process.argv[2]);
const SITE = "https://conclave.test";
// Provider workspaces require trusted ancestors; a shared /tmp cannot hold one.
const root = mkdtempSync(join(process.cwd(), ".seatline-web-connect-"));
const file = name => join(root, name);
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file("authority-key.pem"), "-out", file("authority.pem"), "-days", "1", "-subj", "/CN=Seatline Integration Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", file("key.pem"), "-out", file("request.pem"), "-subj", "/CN=localhost"], { stdio: "ignore" });
writeFileSync(file("extensions.conf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
execFileSync("openssl", ["x509", "-req", "-in", file("request.pem"), "-CA", file("authority.pem"), "-CAkey", file("authority-key.pem"), "-CAcreateserial", "-out", file("certificate.pem"), "-days", "1", "-extfile", file("extensions.conf")], { stdio: "ignore" });

// A relay that hands out pairings and forwards between the two roles of each, as the Worker does.
const channels = new Map();
let pairings = 0;
const hex = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
const server = createServer({ key: readFileSync(file("key.pem")), cert: readFileSync(file("certificate.pem")) }, async (request, response) => {
  if (request.url !== "/pair" || request.method !== "POST") { response.writeHead(404).end(); return; }
  let text = ""; for await (const chunk of request) text += chunk;
  assert.deepEqual(JSON.parse(text), { app: "conclave", origin: SITE });
  const id = hex(); pairings++;
  channels.set(id, { credentials: { helper: hex(), browser: hex() }, peers: new Map() });
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, ...channels.get(id).credentials }));
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket, request) => {
  const [, id, role] = /^\/channels\/([a-f0-9]{64})\/(browser|helper)$/.exec(request.url) ?? [];
  const channel = channels.get(id);
  if (!channel) { socket.close(4410, "Pairing expired"); return; }
  const other = role === "helper" ? "browser" : "helper";
  let authorized = false;
  socket.on("message", data => {
    const value = JSON.parse(String(data));
    if (!authorized) {
      assert.equal(value.type, "auth"); assert.equal(value.token, channel.credentials[role]);
      authorized = true; channel.peers.set(role, socket);
      const peer = channel.peers.get(other);
      socket.send(JSON.stringify({ type: "ready", peer: Boolean(peer) }));
      peer?.send('{"type":"peer","connected":true}'); return;
    }
    if (value.type === "ping") { socket.send('{"type":"pong"}'); return; }
    channel.peers.get(other)?.send(String(data));
  });
  socket.on("close", () => {
    if (channel.peers.get(role) !== socket) return;
    channel.peers.delete(role); channel.peers.get(other)?.send('{"type":"peer","connected":false}');
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const relay = `https://127.0.0.1:${server.address().port}`;

const providerDir = join(root, "providers"); mkdirSync(providerDir);
writeFileSync(join(providerDir, "codex"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.1.0'; exit 0; fi
if [ "$1" = "login" ]; then echo 'Logged in using ChatGPT'; exit 0; fi
cat >/dev/null
echo '{"type":"thread.started","thread_id":"test-session"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"Answer through the web service"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3}}'
`); chmodSync(join(providerDir, "codex"), 0o700);
// A free loopback port for the web service.
const port = await new Promise(resolve => { const probe = createPlainServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const env = { ...process.env, HOME: root, XDG_CACHE_HOME: file("cache"), XDG_DATA_HOME: file("data"), SEATLINE_DATA_DIR: file("seatline"), CONCLAVE_PROVIDER_PATH: providerDir, SSL_CERT_FILE: file("authority.pem"), SEATLINE_WEB_PORT: String(port) };
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[name];
execFileSync(executable, ["authorize", "conclave", "codex", SITE, `--relay=${relay}`], { env, stdio: "ignore" });

/** A request with exactly these headers (fetch would add its own Sec-Fetch-Mode, and cannot set Host). */
const get = (path, headers) => new Promise((resolve, reject) => {
  const request = httpRequest({ host: "127.0.0.1", port, path, headers, setHost: false }, response => {
    let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
  });
  request.on("error", reject); request.end();
});
/** What a browser sends when the website opens the connect page in a window of its own, unless `headers` says otherwise. */
const visit = (query, headers = {}) => get(`/connect?${new URLSearchParams(query)}`, { host: `127.0.0.1:${port}`, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site", ...headers });
/** The pairing the page posts to the window that opened it. */
const posted = page => JSON.parse(/var m=(\{.*?\}),o=/.exec(page)?.[1] ?? "null");
let service; let browser;
const startService = async () => {
  service = spawn(executable, ["web"], { env, stdio: ["ignore", "ignore", "inherit"] });
  for (let i = 0; i < 200; i++) { try { await get("/", { host: `127.0.0.1:${port}` }); return; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
  throw new Error("the web service did not start");
};
const timeout = setTimeout(() => { console.error("Web service integration timed out"); service?.kill(); process.exit(1); }, 60_000);
try {
  await startService();
  const query = { app: "conclave", origin: SITE, relay };

  // Refusals, before any pairing exists.
  assert.equal((await visit(query, { "sec-fetch-dest": "iframe" })).status, 403, "the page cannot be framed");
  assert.equal((await visit(query, { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" })).status, 403, "the page cannot be fetched");
  const unauthorized = await visit({ ...query, origin: "https://attacker.test" });
  assert.equal(unauthorized.status, 403);
  assert.equal(posted(unauthorized.body), null, "an unauthorized website is told nothing");
  assert.equal((await visit(query, { host: `attacker.test:${port}` })).status, 421, "a page reached under another name (DNS rebinding) is refused");
  assert.equal(pairings, 0, "nothing is paired for a refused request");

  // The authorized website gets a pairing, addressed to its own origin, with the protections a browser needs.
  const answer = await visit(query);
  assert.equal(answer.status, 200);
  for (const [name, value] of [["x-frame-options", "DENY"], ["cache-control", "no-store"], ["referrer-policy", "no-referrer"]]) assert.equal(answer.headers[name], value);
  const page = answer.body;
  const pairing = posted(page);
  assert.equal(pairing.type, "seatline-pairing"); assert.equal(pairing.version, 1); assert.equal(pairing.relay, relay);
  assert.ok(page.includes(`o="${SITE}"`), "the pairing is posted only to the authorized origin");
  assert.equal(pairings, 1);
  // Visiting again hands over the same standing pairing.
  assert.equal(posted((await visit(query)).body).id, pairing.id);
  assert.equal(pairings, 1, "a website keeps one standing pairing");

  // The browser side, over the encrypted relay.
  const key = await importKey(Buffer.from(pairing.key, "base64url"));
  const connect = async () => {
    const socket = new WebSocket(`${relay.replace("https:", "wss:")}/channels/${pairing.id}/browser`, { ca: readFileSync(file("authority.pem")), headers: { origin: SITE } });
    const records = []; const waiting = new Map(); let epoch; let nonce; let handshake; let receiving = Promise.resolve();
    const ready = new Promise(resolve => { handshake = resolve; });
    socket.on("message", data => { receiving = receiving.then(async () => {
      const value = JSON.parse(String(data));
      if ((value.type === "ready" && value.peer) || (value.type === "peer" && value.connected)) {
        nonce = newNonce(); epoch = undefined; socket.send(JSON.stringify(await sealHello(key, "browser", nonce))); return;
      }
      if (value.type !== "data") return;
      if (value.seq === 0) { const hello = await openHello(key, "helper", value); assert.equal(hello.echo, nonce); epoch = { helper: hello.nonce, browser: nonce }; handshake(); return; }
      const packet = await open(key, "helper", epoch, value); records.push(packet);
      if (["completed", "failed", "stopped"].includes(packet.event?.type)) waiting.get(packet.id)?.(packet);
    }); });
    await once(socket, "open"); socket.send(JSON.stringify({ type: "auth", token: pairing.token }));
    await ready;
    let sequence = 0;
    const request = async value => { const terminal = new Promise(resolve => waiting.set(value.id, resolve)); socket.send(JSON.stringify(await seal(key, "browser", epoch, ++sequence, value))); return terminal; };
    return { socket, records, request };
  };
  const turn = { system: null, messages: [{ role: "user", text: "hello" }], model: null, tools: "none", session: "ephemeral", continuation: null, cleanup_group: null, check_sign_in: false };
  const ask = async session => {
    const ready = await session.request({ id: "ready", provider: "codex", method: "readiness", params: { mode: "fresh" } });
    assert.equal(ready.event.type, "completed");
    const answered = await session.request({ id: "turn", provider: "codex", method: "send_ready_with_policy", params: { turn, freshness: { mode: "cached", max_age_ms: 30000 }, allowed_sign_in: ["subscription"] } });
    assert.equal(answered.event.type, "completed", JSON.stringify(answered));
    assert.ok(session.records.some(value => value.id === "turn" && value.event.type === "delta" && value.event.text.includes("Answer through the web service")));
  };
  browser = await connect();
  await ask(browser);
  console.log("Web service: the connect page handed the website its pairing, and a turn ran over it");

  // The pairing outlives the service: a restarted service connects its helper side again by itself.
  browser.socket.terminate();
  service.kill(); await once(service, "exit");
  await startService();
  browser = await connect();
  await ask(browser);
  assert.equal(pairings, 1, "a restart keeps the stored pairing");
  console.log("Web service: after a restart the stored pairing reconnected on its own and still works");
} finally {
  clearTimeout(timeout); browser?.socket.terminate(); service?.kill();
  try { execFileSync(executable, ["stop"], { env, stdio: "ignore" }); } catch { /* not running */ }
  for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close();
  rmSync(root, { recursive: true, force: true });
}
