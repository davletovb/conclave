// Integration test tooling only: production Seatline and its transport are Rust.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:https";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { importKey, seal, open, sealHello, openHello, newNonce } from "../cloudflare/crypto.mjs";

const executable = resolve(process.argv[2]);
// Provider workspaces require trusted ancestors; a shared /tmp cannot hold one.
const root = mkdtempSync(join(process.cwd(), ".seatline-web-roundtrip-"));
const certificate = join(root, "certificate.pem");
const privateKey = join(root, "key.pem");
const authority = join(root, "authority.pem");
const authorityKey = join(root, "authority-key.pem");
const certificateRequest = join(root, "certificate-request.pem");
const certificateExtensions = join(root, "certificate-extensions.conf");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", authorityKey, "-out", authority, "-days", "1", "-subj", "/CN=Seatline Integration Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey, "-out", certificateRequest, "-subj", "/CN=localhost"], { stdio: "ignore" });
writeFileSync(certificateExtensions, "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
execFileSync("openssl", ["x509", "-req", "-in", certificateRequest, "-CA", authority, "-CAkey", authorityKey, "-CAcreateserial", "-out", certificate, "-days", "1", "-extfile", certificateExtensions], { stdio: "ignore" });
const credentials = { id: "a".repeat(64), helper: "b".repeat(64), browser: "c".repeat(64) };
const peers = new Map();
const server = createServer({ key: readFileSync(privateKey), cert: readFileSync(certificate) }, async (request, response) => {
  if (request.url !== "/pair" || request.method !== "POST") { response.writeHead(404).end(); return; }
  let text = ""; for await (const chunk of request) text += chunk;
  assert.deepEqual(JSON.parse(text), { app: "conclave", origin: "https://conclave.test" });
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(credentials));
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket, request) => {
  const role = request.url.endsWith("/helper") ? "helper" : "browser";
  let authorized = false;
  socket.on("message", data => {
    const value = JSON.parse(String(data));
    if (!authorized) {
      assert.equal(value.type, "auth"); assert.equal(value.token, credentials[role]);
      authorized = true; peers.set(role, socket);
      const peer = peers.get(role === "helper" ? "browser" : "helper");
      socket.send(JSON.stringify({ type: "ready", peer: Boolean(peer) }));
      peer?.send('{"type":"peer","connected":true}'); return;
    }
    if (value.type === "ping") { socket.send('{"type":"pong"}'); return; }
    peers.get(role === "helper" ? "browser" : "helper")?.send(String(data));
  });
  socket.on("close", () => {
    peers.delete(role); peers.get(role === "helper" ? "browser" : "helper")?.send('{"type":"peer","connected":false}');
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const relay = `https://127.0.0.1:${server.address().port}`;
const providerDir = join(root, "providers"); mkdirSync(providerDir);
const provider = join(providerDir, "codex");
writeFileSync(provider, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.1.0'; exit 0; fi
if [ "$1" = "login" ]; then echo 'Logged in using ChatGPT'; exit 0; fi
cat >/dev/null
echo '{"type":"thread.started","thread_id":"test-session"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"Shared companion answer"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":3}}'
`); chmodSync(provider, 0o700);
const env = { ...process.env, HOME: root, XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), SEATLINE_DATA_DIR: join(root, "seatline"), CONCLAVE_PROVIDER_PATH: providerDir, SSL_CERT_FILE: authority };
for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[name];
execFileSync(executable, ["authorize", "conclave", "codex", "https://conclave.test", `--relay=${relay}`], { env, stdio: "ignore" });
const broker = spawn(executable,["serve"],{env,stdio:"ignore"});
for (let i=0;i<100 && !existsSync(join(env.SEATLINE_DATA_DIR,"broker.sock"));i++) await new Promise(resolve=>setTimeout(resolve,20));
let helper; let browser; const records = []; const waiting = new Map();
const timeout = setTimeout(() => { console.error("Native web integration timed out"); helper?.kill(); broker.kill(); process.exit(1); }, 40_000);
try {
  helper = spawn(executable, ["pair", "conclave", relay, "https://conclave.test"], { env, stdio: ["ignore", "pipe", "inherit"] });
  let printed = "";
  const link = await new Promise((resolve, reject) => {
    helper.once("exit", code => reject(new Error(`Native helper exited ${code}`)));
    helper.stdout.on("data", chunk => {
      printed += chunk;
      const found = /https:\/\/conclave\.test\/#seatline=([^\s]+)/.exec(printed);
      if (found) resolve(found[1]);
    });
  });
  const [id, token, secret] = link.split(":"); assert.equal(id, credentials.id); assert.equal(token, credentials.browser);
  const key = await importKey(Buffer.from(secret, "base64url"));
  browser = new WebSocket(`${relay.replace("https:", "wss:")}/channels/${id}/browser`, { ca: readFileSync(authority), headers: { origin: "https://conclave.test" } });
  let receiving = Promise.resolve();
  // Protocol 2: the browser opens a handshake whenever the helper (re)connects.
  let epoch; let browserNonce; let handshake; let handshakeDone;
  const seen = { peerDisconnects: 0, handshakes: 0 };
  const beginHandshake = () => {
    epoch = undefined; browserNonce = newNonce();
    handshake = new Promise(resolve => { handshakeDone = resolve; });
    return sealHello(key, "browser", browserNonce).then(frame => browser.send(JSON.stringify(frame)));
  };
  const ready = new Promise(resolve => browser.on("message", data => { receiving = receiving.then(async () => {
    const value = JSON.parse(String(data));
    if ((value.type === "ready" && value.peer) || (value.type === "peer" && value.connected)) { await beginHandshake(); resolve(); return; }
    if (value.type === "peer" && !value.connected) { seen.peerDisconnects++; epoch = undefined; return; }
    if (value.type !== "data") return;
    if (value.seq === 0) {
      const hello = await openHello(key, "helper", value);
      assert.equal(hello.echo, browserNonce, "the helper must echo the browser nonce");
      epoch = { helper: hello.nonce, browser: browserNonce }; seen.handshakes++; handshakeDone(); return;
    }
    const packet = await open(key, "helper", epoch, value); records.push(packet);
    if (["completed", "failed", "stopped"].includes(packet.event?.type)) waiting.get(packet.id)?.(packet);
  }).catch(error => {console.error(error);process.exit(1);}); }));
  await once(browser, "open"); browser.send(JSON.stringify({ type: "auth", token })); await ready; await handshake;
  let sequence = 0;
  const request = async (value, number = ++sequence) => {
    const terminal = new Promise(resolve => waiting.set(value.id, resolve));
    browser.send(JSON.stringify(await seal(key, "browser", epoch, number, value)));
    return terminal;
  };
  const until = async (done, message) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(done(), message); };
  assert.equal((await request({ id: "status", provider: "codex", method: "status", params: null })).event.type, "completed");
  const status = records.find(value => value.id === "status" && value.event.type === "status")?.event.status;
  assert.equal(status?.authentication, "authenticated", `Provider status: ${JSON.stringify(status)}`);
  assert.equal((await request({ id: "turn", provider: "codex", method: "send", params: { system: null, messages: [{ role: "user", text: "hello" }], model: null, tools: "none", session: "ephemeral", continuation: null, cleanup_group: null, check_sign_in: true } })).event.type, "completed");
  assert.ok(records.some(value => value.id === "turn" && value.event.type === "delta" && value.event.text.includes("Shared companion answer")));

  // A repeated frame must not schedule another model call: the helper ends the connection instead.
  const count = records.length;
  browser.send(JSON.stringify(await seal(key, "browser", epoch, sequence, { id: "replayed", provider: "codex", method: "status", params: null })));
  await until(() => seen.peerDisconnects >= 1, "a repeated frame must end the helper's connection");
  assert.equal(records.length, count);
  // The helper reconnects, the relay reports it, and a fresh handshake restarts the counters.
  await until(() => seen.handshakes >= 2, "the pairing must recover with a new handshake");
  sequence = 0;
  assert.equal((await request({ id: "after-replay", provider: "codex", method: "status", params: null })).event.type, "completed");

  // A lost frame (a gap) does the same.
  browser.send(JSON.stringify(await seal(key, "browser", epoch, 5, { id: "gap", provider: "codex", method: "status", params: null })));
  await until(() => seen.peerDisconnects >= 2, "a gap must end the helper's connection");
  await until(() => seen.handshakes >= 3, "the pairing must recover after a gap");
  sequence = 0;
  assert.equal((await request({ id: "after-gap", provider: "codex", method: "status", params: null })).event.type, "completed");
  console.log("Protocol 2: handshake, encrypted round trip, replay and gap rejection, and recovery passed");
} finally {
  clearTimeout(timeout); browser?.terminate(); helper?.kill();
  for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.close();
  broker.kill();
  await once(broker,"exit").catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
