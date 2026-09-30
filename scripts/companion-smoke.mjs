import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const state = mkdtempSync(join(tmpdir(), "conclave-stdio-"));
const entry = resolve(process.argv[2] ?? "apps/server/dist/companion.js");
const child = spawn(process.execPath, [entry], { env: { ...process.env, CONCLAVE_DATA_DIR: state }, stdio: ["pipe", "pipe", "inherit"] });
let bytes = Buffer.alloc(0);
const calls = new Map();
let ready;
const connected = new Promise(resolve => { ready = resolve; });
child.stdout.on("data", chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE(0) + 4) {
    const length = bytes.readUInt32LE(0); assert.ok(length > 0 && length <= 1024 * 1024);
    const packet = JSON.parse(bytes.subarray(4, length + 4).toString("utf8")); bytes = bytes.subarray(length + 4);
    if (packet.type === "ready") { ready(packet); continue; }
    const call = calls.get(packet.id); if (!call) continue;
    if (packet.type === "head") call.status = packet.status;
    if (packet.type === "chunk") call.chunks.push(Buffer.from(packet.data, "base64"));
    if (packet.type === "end") { calls.delete(packet.id); call.resolve({ status: call.status, body: Buffer.concat(call.chunks).toString("utf8") }); }
  }
});
function request(path, method = "GET", body) {
  const id = randomUUID();
  const result = new Promise(resolve => calls.set(id, { resolve, chunks: [], status: 0 }));
  const bytes = Buffer.from(JSON.stringify({ id, type: "request", path, method, body: body === undefined ? undefined : JSON.stringify(body) }));
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); child.stdin.write(Buffer.concat([header, bytes]));
  return result;
}
const timeout = setTimeout(() => { console.error("Companion smoke test timed out"); child.kill(); process.exitCode = 1; }, 30_000);
try {
  const hello = await connected; assert.equal(hello.version, 1); assert.equal(hello.app, "conclave");
  assert.deepEqual(JSON.parse((await request("/health")).body), { ok: true });
  const started = await request("/runs", "POST", { request: { mode: "single", prompt: "Say hello", participants: [{ provider: "mock", model: "mock-gpt", label: "Mock" }] } });
  assert.equal(started.status, 200);
  const { runId, conversationId } = JSON.parse(started.body);
  assert.ok(runId && conversationId);
  const stream = await request(`/runs/${runId}/events?after=0&follow=1`);
  const events = stream.body.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(record => record.event.type === "run_completed"));
  for (let i = 1; i < events.length; i++) assert.ok(events[i].seq > events[i - 1].seq);
  const replay = await request(`/runs/${runId}/events?after=${events.at(-1).seq}&follow=0`); assert.equal(replay.body, "");
  const history = await request(`/conversations/${conversationId}`); assert.equal(history.status, 200);
  assert.ok(JSON.parse(history.body).messages.length >= 2);
  assert.equal((await request("//attacker.example/")).status, 400);
  console.log("Conclave stdio run, history, stream, cursor replay, and URL boundary passed");
} finally {
  clearTimeout(timeout); child.stdin.end();
  await new Promise(resolve => { child.once("exit", resolve); setTimeout(() => { child.kill(); resolve(); }, 3000).unref(); });
  rmSync(state, { recursive: true, force: true });
}
