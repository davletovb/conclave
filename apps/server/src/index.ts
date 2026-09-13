import Fastify from "fastify";
import cors from "@fastify/cors";
import type { OrchestrationRequest, ProviderStatus } from "@conclave/core";
import { MockProvider } from "./providers/mock.js";
import { OpenAICodexProvider } from "./providers/openai-codex.js";
import { Orchestrator } from "./orchestrator.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const mock = new MockProvider();
const openai = new OpenAICodexProvider();
const orchestrator = new Orchestrator(new Map([
  [mock.id, mock],
  [openai.id, openai],
]));

app.get("/health", async () => ({ ok: true }));

app.get("/providers", async (): Promise<ProviderStatus[]> => {
  const openaiStatus = await openai.status();
  return [
    openaiStatus,
    {
      id: "mock",
      label: "Mock provider",
      available: true,
      connected: true,
      authMode: "mock",
      message: "Fallback models for providers that are not connected yet",
    },
  ];
});

app.get("/models", async () => {
  const mockModels = await mock.listModels();
  try {
    const openaiModels = await openai.listModels();
    if (openaiModels.length === 0) return mockModels;

    // During the incremental rollout, real OpenAI replaces mock GPT while
    // Claude and Grok remain mocks until their adapters land.
    return [
      ...openaiModels,
      ...mockModels.filter(model => model.model !== "mock-gpt"),
    ];
  } catch {
    return mockModels;
  }
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

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "0.0.0.0" });

const shutdown = async () => {
  openai.close();
  await app.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
