import Fastify from "fastify";
import cors from "@fastify/cors";
import type {
  OrchestrationRequest,
  OrchestrationStreamEvent,
  ProviderAdapter,
  ProviderStatus,
} from "@conclave/core";
import { AnthropicClaudeProvider } from "./providers/anthropic-claude.js";
import { MockProvider } from "./providers/mock.js";
import { OpenAICodexProvider } from "./providers/openai-codex.js";
import { XaiGrokProvider } from "./providers/xai-grok.js";
import { Orchestrator } from "./orchestrator.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const mock = new MockProvider();
const openai = new OpenAICodexProvider();
const anthropic = new AnthropicClaudeProvider();
const xai = new XaiGrokProvider();
const providers = new Map<string, ProviderAdapter>([
  [mock.id, mock],
  [openai.id, openai],
  [anthropic.id, anthropic],
  [xai.id, xai],
]);
const orchestrator = new Orchestrator(providers);

app.get("/health", async () => ({ ok: true }));

app.get("/providers", async (): Promise<ProviderStatus[]> => {
  const [openaiStatus, anthropicStatus, xaiStatus] = await Promise.all([
    openai.status(),
    anthropic.status(),
    xai.status(),
  ]);

  return [
    openaiStatus,
    anthropicStatus,
    xaiStatus,
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

app.get("/models", async () => {
  const mockModels = await mock.listModels();
  const [openaiModels, anthropicModels, xaiModels] = await Promise.all([
    openai.listModels().catch(() => []),
    anthropic.listModels().catch(() => []),
    xai.listModels().catch(() => []),
  ]);

  const mockGpt = mockModels.filter(model => model.model === "mock-gpt");
  const mockClaude = mockModels.filter(model => model.model === "mock-claude");
  const mockGrok = mockModels.filter(model => model.model === "mock-grok");

  return [
    ...(openaiModels.length > 0 ? openaiModels : mockGpt),
    ...(anthropicModels.length > 0 ? anthropicModels : mockClaude),
    ...(xaiModels.length > 0 ? xaiModels : mockGrok),
  ];
});

app.post<{ Body: OrchestrationRequest }>("/orchestrate", async (request, reply) => {
  try {
    return await orchestrator.run(request.body);
  } catch (error) {
    request.log.error(error);
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Unknown orchestration error",
    });
  }
});

app.post<{ Body: OrchestrationRequest }>("/orchestrate/stream", async (request, reply) => {
  reply.hijack();
  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  raw.setHeader("cache-control", "no-cache, no-transform");
  raw.setHeader("connection", "keep-alive");
  raw.setHeader("access-control-allow-origin", "*");
  raw.flushHeaders?.();

  const emit = (event: OrchestrationStreamEvent) => {
    if (!raw.destroyed && !raw.writableEnded) {
      raw.write(`${JSON.stringify(event)}\n`);
    }
  };

  try {
    await orchestrator.run(request.body, { emit });
  } catch (error) {
    request.log.error(error);
  } finally {
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  }
});

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "0.0.0.0" });

const shutdown = async () => {
  openai.close();
  await app.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
