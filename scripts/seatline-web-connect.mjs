// Integration test tooling only: production Seatline and its transport are Rust.
//
// Linked browsers and the background web service, against a stand-in relay: `seatline-companion link`
// makes a pairing for one browser and prints its link, `seatline-companion web` keeps every link's helper
// side connected (it opens no port), the browser uses its link over the encrypted relay, links survive a
// restart of the service, and `unlink` ends them.
import assert from "node:assert/strict";
import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:https";
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
const env = { ...process.env, HOME: root, XDG_CACHE_HOME: file("cache"), XDG_DATA_HOME: file("data"), SEATLINE_DATA_DIR: file("seatline"), CONCLAVE_PROVIDER_PATH: providerDir, SSL_CERT_FILE: file("authority.pem") };
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[name];
execFileSync(executable, ["authorize", "conclave", "codex", SITE, `--relay=${relay}`], { env, stdio: "ignore" });

let service; let browser;
const startService = () => { service = spawn(executable, ["web"], { env, stdio: ["ignore", "ignore", "inherit"] }); };
/** Links one more browser; returns the pairing its printed link carries. */
// Asynchronous: the relay answering it runs in this process.
const run = async (...args) => (await promisify(execFile)(executable, args, { env, encoding: "utf8" })).stdout;
const link = async () => {
  const printed = await run("link", "conclave");
  const found = /https:\/\/conclave\.test\/#seatline=([a-f0-9]{64}):([a-f0-9]{64}):([A-Za-z0-9_-]{43})/.exec(printed);
  assert.ok(found, `link printed: ${printed}`);
  return { id: found[1], token: found[2], key: found[3] };
};
const timeout = setTimeout(() => { console.error("Web service integration timed out"); service?.kill(); process.exit(1); }, 60_000);
try {
  startService();
  const pairing = await link();
  assert.equal(pairings, 1);
  const stored = JSON.parse(readFileSync(file("seatline/web/conclave.json"), "utf8"));
  assert.equal(stored.links.length, 1);

  // The browser side, over the encrypted relay.
    const connect = async pairing => {
    const socket = new WebSocket(`${relay.replace("https:", "wss:")}/channels/${pairing.id}/browser`, { ca: readFileSync(file("authority.pem")), headers: { origin: SITE } });
    const key = await importKey(Buffer.from(pairing.key, "base64url"));
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
  browser = await connect(pairing);
  await ask(browser);
  console.log("Linked browser: the service connected its link by itself, and a turn ran over it");

  // A second browser gets a link of its own; both work.
  const second = await link();
  assert.notEqual(second.id, pairing.id);
  const other = await connect(second);
  await ask(other);
  other.socket.terminate();

  // Links outlive the service: a restarted one connects them again by itself.
  browser.socket.terminate();
  service.kill(); await once(service, "exit");
  startService();
  browser = await connect(pairing);
  await ask(browser);
  assert.equal(pairings, 2, "a restart makes no new pairing");
  console.log("Linked browser: after a restart the stored link reconnected on its own and still works");

  // Unlinking ends them: the service lets go of the relay, and the browser is told Seatline left.
  const left = new Promise(resolve => browser.socket.on("message", data => { if (String(data).includes('"connected":false')) resolve(); }));
  assert.match(await run("unlink", "conclave"), /Ended 2 link/);
  await left;
  console.log("Linked browser: unlink ended the links and the service let go of them");
} finally {
  clearTimeout(timeout); browser?.socket.terminate(); service?.kill();
  try { execFileSync(executable, ["stop"], { env, stdio: "ignore" }); } catch { /* not running */ }
  for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close();
  rmSync(root, { recursive: true, force: true });
}
