import Fastify from "fastify";
import cors from "@fastify/cors";
import type { OrchestrationRequest } from "@conclave/core";
import { MockProvider } from "./providers/mock.js";
import { Orchestrator } from "./orchestrator.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

const mock = new MockProvider();
const orchestrator = new Orchestrator(new Map([[mock.id, mock]]));

app.get("/health", async () => ({ ok: true }));
app.get("/models", async () => mock.listModels());
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
