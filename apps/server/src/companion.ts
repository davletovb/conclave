import { once } from "node:events";
import type { RunEventRecord } from "@conclave/core";
import { createConclaveRuntime } from "./runtime.js";

const runtime = await createConclaveRuntime(true);
await runtime.app.ready();
const MAX_FRAME = 1024 * 1024;
const streams = new Map<string, () => void>();
const active = new Set<string>();
let writing = Promise.resolve();
let queuedBytes = 0;

function send(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_FRAME || queuedBytes + bytes.length > 4 * MAX_FRAME) throw new Error("Companion output queue is full");
  const frame = Buffer.alloc(bytes.length + 4);
  frame.writeUInt32LE(bytes.length, 0); bytes.copy(frame, 4);
  queuedBytes += frame.length;
  writing = writing.then(async () => {
    if (!process.stdout.write(frame)) await once(process.stdout, "drain");
    queuedBytes -= frame.length;
  }).catch(() => process.exit(1));
}
function chunk(id: string, data: string) {
  const bytes = Buffer.from(data);
  for (let offset = 0; offset < bytes.length; offset += 16384) send({ id, type: "chunk", data: bytes.subarray(offset, offset + 16384).toString("base64") });
}
function reply(id: string, status: number, body: string, headers: Record<string, string> = { "content-type": "application/json" }) {
  send({ id, type: "head", status, headers }); chunk(id, body); send({ id, type: "end" }); active.delete(id);
}

async function events(id: string, url: URL, runId: string) {
  const run = await runtime.runManager.getRun(runId);
  if (!run) { reply(id, 404, JSON.stringify({ error: "Run not found" })); return; }
  let cursor = Math.max(0, Number(url.searchParams.get("after")) || 0);
  let replaying = true;
  let closed = false;
  const buffered: RunEventRecord[] = [];
  const finish = () => {
    if (closed) return;
    closed = true; unsubscribe(); streams.delete(id); active.delete(id); send({ id, type: "end" });
  };
  const write = (record: RunEventRecord) => {
    if (closed || record.seq <= cursor) return;
    cursor = record.seq; chunk(id, `${JSON.stringify(record)}\n`);
    if (["run_completed", "run_cancelled", "error"].includes(record.event.type)) finish();
  };
  const unsubscribe = runtime.runManager.subscribe(runId, record => {
    try {
      if (replaying) { if (buffered.length >= 256) throw new Error("Replay queue full"); buffered.push(record); }
      else write(record);
    } catch { finish(); }
  });
  streams.set(id, finish);
  send({ id, type: "head", status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  try {
    for (const record of await runtime.runManager.events(runId, cursor)) write(record);
    replaying = false;
    for (const record of buffered.sort((a, b) => a.seq - b.seq)) write(record);
    const latest = await runtime.runManager.getRun(runId);
    if (url.searchParams.get("follow") === "0" || !latest || ["completed", "failed", "cancelled", "interrupted"].includes(latest.status)) finish();
  } catch { finish(); }
}

async function handle(value: { id?: unknown; type?: unknown; path?: unknown; method?: unknown; body?: unknown }) {
  const id = value.id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(id)) throw new Error("Invalid request ID");
  if (value.type === "abort") { streams.get(id)?.(); return; }
  if (value.type === "disconnect") { for (const finish of [...streams.values()]) finish(); return; }
  if (active.has(id)) throw new Error("Duplicate request ID");
  if (active.size >= 32) { reply(id, 429, JSON.stringify({ error: "Companion request queue is full" })); return; }
  active.add(id);
  try {
    if (typeof value.path !== "string" || !value.path.startsWith("/") || value.path.startsWith("//")) throw new Error("Invalid request path");
    const url = new URL(value.path, "http://conclave.internal");
    if (url.origin !== "http://conclave.internal") throw new Error("Invalid request origin");
    const method = typeof value.method === "string" ? value.method.toUpperCase() : "GET";
    if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) throw new Error("Invalid request method");
    const stream = /^\/runs\/([a-zA-Z0-9_-]+)\/events$/.exec(url.pathname);
    if (stream && method === "GET") { await events(id, url, stream[1]); return; }
    if (url.pathname === "/orchestrate/stream") throw new Error("Use the persistent run API for streaming");
    const response = await runtime.app.inject({ method: method as "GET" | "POST" | "PATCH" | "DELETE", url: value.path,
      payload: typeof value.body === "string" ? value.body : undefined,
      headers: typeof value.body === "string" ? { "content-type": "application/json" } : undefined });
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "content-disposition"]) {
      const header = response.headers[name]; if (typeof header === "string") headers[name] = header;
    }
    reply(id, response.statusCode, response.body, headers);
  } catch (error) { reply(id, 400, JSON.stringify({ error: error instanceof Error ? error.message : "Companion request failed" })); }
}

let input = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (!length || length > MAX_FRAME) process.exit(1);
    if (input.length < length + 4) return;
    let value: Parameters<typeof handle>[0];
    try { value = JSON.parse(input.subarray(4, length + 4).toString("utf8")); } catch { process.exit(1); }
    input = input.subarray(length + 4);
    void handle(value).catch(() => process.exit(1));
  }
});
async function close() { for (const finish of [...streams.values()]) finish(); await runtime.close(); await writing; process.exit(0); }
process.stdin.once("end", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
send({ type: "ready", version: 1, app: "conclave" });
