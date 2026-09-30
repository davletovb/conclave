import type { ProviderAdapter, ProviderStatus, RunEventRecord, StartRunRequest } from "@conclave/core";
import { Orchestrator } from "../../../server/src/orchestrator";
import { MockProvider } from "../../../server/src/providers/mock";
import { RunManager } from "../../../server/src/state/run-manager";
import { StateStore } from "../../../server/src/state/store";
import { exportFilename, exportToMarkdown } from "../../../server/src/state/conversation-export";
import { workflowPresets } from "../../../server/src/workflow-presets";
import { BrowserStorage } from "./browser-storage";
import { SeatlineClient } from "./companion";
import { SeatlineProvider } from "./seatline-provider";

type Runtime = { manager: RunManager; mock: MockProvider; providers: SeatlineProvider[] };
let runtime: Promise<Runtime> | undefined;

async function initialize(): Promise<Runtime> {
  // One engine per browser origin; another tab must not mark a live run stale.
  if (navigator.locks) {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    await new Promise<void>((resolve, reject) => {
      void navigator.locks.request("conclave.engine.v1", { mode: "exclusive", ifAvailable: true }, async lock => {
        if (!lock) { reject(new Error("Conclave is already open in another tab. Use that tab or close it first.")); return; }
        resolve(); await hold;
      }).catch(reject);
    });
    window.addEventListener("pagehide", release, { once: true });
  }
  const client = new SeatlineClient();
  const providers = [new SeatlineProvider("openai", "OpenAI Codex", "codex", client),
    new SeatlineProvider("anthropic", "Claude Code", "claude", client),
    new SeatlineProvider("xai", "Grok", "grok", client),
    new SeatlineProvider("google", "Google Gemini", "gemini", client)];
  const mock = new MockProvider();
  const registry = new Map<string, ProviderAdapter>([mock, ...providers].map(provider => [provider.id, provider]));
  const manager = new RunManager(new Orchestrator(registry), new StateStore("conclave", new BrowserStorage()));
  await manager.init();
  return { manager, providers, mock };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function streamEvents(manager: RunManager, id: string, url: URL, signal?: AbortSignal | null) {
  const run = await manager.getRun(id); if (!run) return json({ error: "Run not found" }, 404);
  let cursor = Math.max(0, Number(url.searchParams.get("after")) || 0);
  let replaying = true; let closed = false; const buffered: RunEventRecord[] = [];
  let unsubscribe = () => {}; let controller!: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => { if (closed) return; closed = true; unsubscribe(); signal?.removeEventListener("abort", finish); controller.close(); };
  const write = (record: RunEventRecord) => {
    if (closed || record.seq <= cursor) return;
    if ((controller.desiredSize ?? 0) < -4 * 1024 * 1024) { finish(); return; }
    cursor = record.seq; controller.enqueue(new TextEncoder().encode(`${JSON.stringify(record)}\n`));
    if (["run_completed", "run_cancelled", "error"].includes(record.event.type)) finish();
  };
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { closed = true; unsubscribe(); signal?.removeEventListener("abort", finish); } }, { highWaterMark: 1024 * 1024, size: bytes => bytes.length });
  unsubscribe = manager.subscribe(id, record => {
    if (replaying) { if (buffered.length < 256) buffered.push(record); else finish(); }
    else write(record);
  });
  signal?.addEventListener("abort", finish, { once: true });
  if (signal?.aborted) finish();
  void (async () => {
    try {
      for (const record of await manager.events(id, cursor)) write(record);
      replaying = false; for (const record of buffered.sort((a, b) => a.seq - b.seq)) write(record);
      const latest = await manager.getRun(id);
      if (url.searchParams.get("follow") === "0" || !latest || ["completed", "failed", "cancelled", "interrupted"].includes(latest.status)) finish();
    } catch { finish(); }
  })();
  return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
}

/** App API runs with the hosted website. Only provider operations reach Seatline. */
export async function hostedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  try {
    runtime ??= initialize(); const { manager, providers, mock } = await runtime;
    const url = new URL(path, "https://conclave.internal");
    if (url.origin !== "https://conclave.internal") return json({ error: "Invalid app path" }, 400);
    const method = init.method?.toUpperCase() ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/providers") {
      const status: ProviderStatus[] = await Promise.all(providers.map(provider => provider.status()));
      return json([...status, { id: "mock", label: "Mock provider", available: true, connected: true, authMode: "mock" }]);
    }
    if (url.pathname === "/provider-limits") return json(await Promise.all(providers.map(provider => provider.limits())));
    if (url.pathname === "/models") {
      const fallback = await mock.listModels();
      const names = ["mock-gpt", "mock-claude", "mock-grok", "mock-gemini"];
      const catalog = await Promise.all(providers.map(async (provider, index) => {
        const models = await provider.listModels().catch(() => []);
        return models.length ? models : fallback.filter(model => model.model === names[index]);
      }));
      return json(catalog.flat());
    }
    if (url.pathname === "/workflow-presets") return json(workflowPresets);
    if (url.pathname === "/conversations" && method === "GET") return json(await manager.listConversations({ query: url.searchParams.get("q") ?? "", limit: Number(url.searchParams.get("limit")) || undefined }));
    if (url.pathname === "/runs" && method === "POST") return json(await manager.start(body as StartRunRequest));
    const conversation = /^\/conversations\/([a-zA-Z0-9_-]+)(\/export)?$/.exec(url.pathname);
    if (conversation) {
      const id = conversation[1];
      if (conversation[2]) {
        const data = await manager.exportConversation(id); if (!data) return json({ error: "Conversation not found" }, 404);
        const format = url.searchParams.get("format") === "markdown" ? "markdown" : "json";
        return new Response(format === "markdown" ? exportToMarkdown(data) : JSON.stringify(data, null, 2), { headers: {
          "content-type": format === "markdown" ? "text/markdown; charset=utf-8" : "application/json",
          "content-disposition": `attachment; filename="${exportFilename(data.conversation.title, format)}"`,
        } });
      }
      if (method === "DELETE") return json(await manager.deleteConversation(id));
      if (method === "PATCH") return json(await manager.renameConversation(id, body?.title));
      const data = await manager.getConversation(id); return data ? json(data) : json({ error: "Conversation not found" }, 404);
    }
    const run = /^\/runs\/([a-zA-Z0-9_-]+)(\/(cancel|resume|inspection|events))?$/.exec(url.pathname);
    if (run) {
      const id = run[1]; const action = run[3];
      if (action === "events" && method === "GET") return streamEvents(manager, id, url, init.signal);
      if (action === "cancel" && method === "POST") return json(await manager.cancel(id));
      if (action === "resume" && method === "POST") return json(await manager.resume(id));
      const data = action === "inspection" ? await manager.inspect(id) : await manager.getRun(id);
      return data ? json(data) : json({ error: "Run not found" }, 404);
    }
    return json({ error: "App endpoint not found" }, 404);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Conclave request failed" }, 400); }
}
