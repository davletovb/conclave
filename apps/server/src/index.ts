import Fastify from "fastify";
import cors from "@fastify/cors";
import type {
  OrchestrationRequest,
  OrchestrationStreamEvent,
  ProviderAdapter,
  ProviderLimitSnapshot,
  ProviderStatus,
  RunEventRecord,
  StartRunRequest,
} from "@conclave/core";
import { AnthropicClaudeProvider } from "./providers/anthropic-claude.js";
import { GoogleGeminiProvider } from "./providers/google-gemini.js";
import { MockProvider } from "./providers/mock.js";
import { OpenAICodexProvider } from "./providers/openai-codex.js";
import { XaiGrokProvider } from "./providers/xai-grok.js";
import { Orchestrator } from "./orchestrator.js";
import { exportFilename, exportToMarkdown } from "./state/conversation-export.js";
import { FileStateStore } from "./state/file-store.js";
import { RunManager } from "./state/run-manager.js";
import { workflowPresets } from "./workflow-presets.js";

const DEFAULT_MAX_CALLS = 12;
const ABSOLUTE_MAX_CALLS = 64;

const allowedOrigins = (process.env.CONCLAVE_WEB_ORIGIN
  ? process.env.CONCLAVE_WEB_ORIGIN.split(",")
  : ["http://localhost:5173", "http://127.0.0.1:5173"])
  .map(origin => origin.trim())
  .filter(Boolean);

const app = Fastify({ logger: true });
await app.register(cors, {
  origin: allowedOrigins,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  // Conversation exports carry their filename in content-disposition, which a
  // browser hides from fetch() unless the server exposes it explicitly.
  exposedHeaders: ["content-disposition"],
});

function applyStreamCors(raw: import("node:http").ServerResponse, origin?: string) {
  if (!origin || !allowedOrigins.includes(origin)) return;
  raw.setHeader("access-control-allow-origin", origin);
  raw.setHeader("vary", "origin");
}

function controlledRequest(request: OrchestrationRequest): OrchestrationRequest {
  const maxCalls = request.budget?.maxCalls ?? DEFAULT_MAX_CALLS;
  const maxRounds = request.budget?.maxRounds ?? request.maxRounds ?? 1;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > ABSOLUTE_MAX_CALLS) {
    throw new Error(`maxCalls must be an integer between 1 and ${ABSOLUTE_MAX_CALLS}`);
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 3) {
    throw new Error("maxRounds must be an integer between 1 and 3");
  }
  return {
    ...request,
    budget: { maxCalls, maxRounds },
  };
}

const mock = new MockProvider();
const openai = new OpenAICodexProvider();
const anthropic = new AnthropicClaudeProvider();
const xai = new XaiGrokProvider();
const google = new GoogleGeminiProvider();
const providers = new Map<string, ProviderAdapter>([
  [mock.id, mock],
  [openai.id, openai],
  [anthropic.id, anthropic],
  [xai.id, xai],
  [google.id, google],
]);
const orchestrator = new Orchestrator(providers);
const stateStore = new FileStateStore();
const runManager = new RunManager(orchestrator, stateStore);
await runManager.init();

app.get("/health", async () => ({ ok: true }));

app.get("/providers", async (): Promise<ProviderStatus[]> => {
  const [openaiStatus, anthropicStatus, xaiStatus, googleStatus] = await Promise.all([
    openai.status(),
    anthropic.status(),
    xai.status(),
    google.status(),
  ]);

  return [
    openaiStatus,
    anthropicStatus,
    xaiStatus,
    googleStatus,
    {
      id: "mock",
      label: "Mock provider",
      available: true,
      connected: true,
      authMode: "mock",
      message: "Fallback models remain available for providers that are not connected yet",
    },
  ];
});

app.get("/provider-limits", async (): Promise<ProviderLimitSnapshot[]> => {
  const openaiLimits = await openai.limits().catch(error => ({
    provider: "openai" as const,
    available: false,
    message: error instanceof Error ? error.message : "OpenAI rate limits unavailable",
  }));

  return [
    openaiLimits,
    {
      provider: "anthropic",
      available: false,
      message: "Claude Code does not expose a stable structured subscription-limit snapshot to Conclave.",
    },
    {
      provider: "xai",
      available: false,
      message: "Grok Build ACP does not expose a stable structured subscription-limit snapshot to Conclave.",
    },
    {
      provider: "google",
      available: false,
      message: "Antigravity CLI does not expose a stable structured Google-account quota snapshot to Conclave.",
    },
  ];
});

app.get("/models", async () => {
  const mockModels = await mock.listModels();
  const [openaiModels, anthropicModels, xaiModels, googleModels] = await Promise.all([
    openai.listModels().catch(() => []),
    anthropic.listModels().catch(() => []),
    xai.listModels().catch(() => []),
    google.listModels().catch(() => []),
  ]);

  const mockGpt = mockModels.filter(model => model.model === "mock-gpt");
  const mockClaude = mockModels.filter(model => model.model === "mock-claude");
  const mockGrok = mockModels.filter(model => model.model === "mock-grok");
  const mockGemini = mockModels.filter(model => model.model === "mock-gemini");

  return [
    ...(openaiModels.length > 0 ? openaiModels : mockGpt),
    ...(anthropicModels.length > 0 ? anthropicModels : mockClaude),
    ...(xaiModels.length > 0 ? xaiModels : mockGrok),
    ...(googleModels.length > 0 ? googleModels : mockGemini),
  ];
});

app.get("/workflow-presets", async () => workflowPresets);

app.get<{ Querystring: { q?: string; limit?: string } }>("/conversations", async request => {
  const limit = Number(request.query.limit);
  return runManager.listConversations({
    query: request.query.q ?? "",
    limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
  });
});

app.get<{ Params: { id: string } }>("/conversations/:id", async (request, reply) => {
  const conversation = await runManager.getConversation(request.params.id);
  if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
  return conversation;
});

app.patch<{ Params: { id: string }; Body: { title?: string } }>("/conversations/:id", async (request, reply) => {
  if (typeof request.body?.title !== "string") {
    return reply.code(400).send({ error: "A string title is required" });
  }
  try {
    return await runManager.renameConversation(request.params.id, request.body.title);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not rename conversation";
    return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
  }
});

app.delete<{ Params: { id: string } }>("/conversations/:id", async (request, reply) => {
  try {
    return await runManager.deleteConversation(request.params.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not delete conversation";
    return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
  }
});

app.get<{
  Params: { id: string };
  Querystring: { format?: string };
}>("/conversations/:id/export", async (request, reply) => {
  const data = await runManager.exportConversation(request.params.id);
  if (!data) return reply.code(404).send({ error: "Conversation not found" });

  const format = request.query.format === "markdown" ? "markdown" : "json";
  reply.header(
    "content-disposition",
    `attachment; filename="${exportFilename(data.conversation.title, format)}"`,
  );
  if (format === "markdown") {
    reply.type("text/markdown; charset=utf-8");
    return exportToMarkdown(data);
  }
  reply.type("application/json; charset=utf-8");
  return data;
});

app.post<{ Body: StartRunRequest }>("/runs", async (request, reply) => {
  try {
    return await runManager.start(request.body);
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Could not start run",
    });
  }
});

app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
  const run = await runManager.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });
  return run;
});

app.get<{ Params: { id: string } }>("/runs/:id/inspection", async (request, reply) => {
  const inspection = await runManager.inspect(request.params.id);
  if (!inspection) return reply.code(404).send({ error: "Run not found" });
  return inspection;
});

app.post<{ Params: { id: string } }>("/runs/:id/cancel", async (request, reply) => {
  try {
    return await runManager.cancel(request.params.id);
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : "Could not cancel run",
    });
  }
});

app.post<{ Params: { id: string } }>("/runs/:id/resume", async (request, reply) => {
  try {
    return await runManager.resume(request.params.id);
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : "Could not resume run",
    });
  }
});

app.get<{
  Params: { id: string };
  Querystring: { after?: string; follow?: string };
}>("/runs/:id/events", async (request, reply) => {
  const run = await runManager.getRun(request.params.id);
  if (!run) return reply.code(404).send({ error: "Run not found" });

  const after = Math.max(0, Number(request.query.after ?? 0) || 0);
  const follow = request.query.follow !== "0";
  reply.hijack();
  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  raw.setHeader("cache-control", "no-cache, no-transform");
  raw.setHeader("connection", "keep-alive");
  applyStreamCors(raw, request.headers.origin);
  raw.flushHeaders?.();

  let cursor = after;
  let replaying = true;
  let closed = false;
  const buffered: RunEventRecord[] = [];
  const terminal = (record: RunEventRecord) => (
    record.event.type === "run_completed"
    || record.event.type === "run_cancelled"
    || record.event.type === "error"
  );
  const write = (record: RunEventRecord) => {
    if (closed || record.seq <= cursor || raw.destroyed || raw.writableEnded) return;
    cursor = record.seq;
    raw.write(`${JSON.stringify(record)}\n`);
    if (terminal(record)) finish();
  };
  const onLive = (record: RunEventRecord) => {
    if (replaying) buffered.push(record);
    else write(record);
  };
  const unsubscribe = runManager.subscribe(run.id, onLive);
  const finish = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  };

  raw.once("close", finish);

  try {
    const backlog = await runManager.events(run.id, after);
    for (const record of backlog) write(record);
    replaying = false;
    for (const record of buffered.sort((a, b) => a.seq - b.seq)) write(record);

    const latest = await runManager.getRun(run.id);
    if (!follow || !latest || ["completed", "failed", "interrupted", "cancelled"].includes(latest.status)) finish();
  } catch (error) {
    request.log.error(error);
    finish();
  }
});

app.post<{ Body: OrchestrationRequest }>("/orchestrate", async (request, reply) => {
  try {
    return await orchestrator.run(controlledRequest(request.body));
  } catch (error) {
    request.log.error(error);
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Unknown orchestration error",
    });
  }
});

// Compatibility endpoint for clients that have not moved to persistent runs yet.
app.post<{ Body: OrchestrationRequest }>("/orchestrate/stream", async (request, reply) => {
  let controlled: OrchestrationRequest;
  try {
    controlled = controlledRequest(request.body);
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Invalid orchestration budget",
    });
  }

  reply.hijack();
  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  raw.setHeader("cache-control", "no-cache, no-transform");
  raw.setHeader("connection", "keep-alive");
  applyStreamCors(raw, request.headers.origin);
  raw.flushHeaders?.();

  const emit = (event: OrchestrationStreamEvent) => {
    if (!raw.destroyed && !raw.writableEnded) {
      raw.write(`${JSON.stringify(event)}\n`);
    }
  };

  try {
    await orchestrator.run(controlled, { emit });
  } catch (error) {
    request.log.error(error);
  } finally {
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  }
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.CONCLAVE_HOST ?? "127.0.0.1";
await app.listen({ port, host });

const shutdown = async () => {
  openai.close();
  await app.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);