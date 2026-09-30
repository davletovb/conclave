import { createConclaveRuntime } from "./runtime.js";
const runtime = await createConclaveRuntime();
await runtime.app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.CONCLAVE_HOST ?? "127.0.0.1" });
process.once("SIGINT", () => void runtime.close());
process.once("SIGTERM", () => void runtime.close());
