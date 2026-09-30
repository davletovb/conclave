import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { BrowserStorage } from "./browser-storage";
import { StateStore } from "../../../server/src/state/store";
import { RunManager } from "../../../server/src/state/run-manager";
import { Orchestrator } from "../../../server/src/orchestrator";
import { MockProvider } from "../../../server/src/providers/mock";

describe("Conclave browser engine persistence", () => {
  it("runs a council, replays events, and recovers history from IndexedDB without an app server", async () => {
    const database = `conclave-test-${crypto.randomUUID()}`;
    const store = new StateStore("conclave", new BrowserStorage(database));
    const mock = new MockProvider();
    const manager = new RunManager(new Orchestrator(new Map([[mock.id, mock]])), store);
    await manager.init();
    const started = await manager.start({ request: { mode: "single", prompt: "Say hello", participants: [{ provider: "mock", model: "mock-gpt", label: "Mock" }] } });
    const deadline = Date.now() + 3000;
    while ((await manager.getRun(started.runId))?.status !== "completed" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect((await manager.getRun(started.runId))?.status).toBe("completed");
    const events = await manager.events(started.runId);
    expect(events.some(record => record.event.type === "run_completed")).toBe(true);
    expect(await manager.events(started.runId, events.at(-1)!.seq)).toEqual([]);
    const recovered = new StateStore("conclave", new BrowserStorage(database)); await recovered.init();
    expect((await recovered.getConversation(started.conversationId))?.messages.length).toBeGreaterThanOrEqual(2);
    expect((await recovered.getRun(started.runId))?.status).toBe("completed");
    expect(await manager.inspect(started.runId)).toMatchObject({ run: { id: started.runId } });
    await recovered.deleteConversation(started.conversationId);
    expect(await recovered.getConversation(started.conversationId)).toBeNull();
  });
  it("marks unfinished browser runs interrupted rather than silently resubmitting them", async () => {
    const database = `conclave-test-${crypto.randomUUID()}`;
    const store = new StateStore("conclave", new BrowserStorage(database)); await store.init();
    const created = await store.createRun({ mode: "single", prompt: "hello", participants: [{ provider: "mock", model: "mock-gpt", label: "Mock" }] });
    await store.updateRun(created.run.id, { status: "running" });
    const recovered = new StateStore("conclave", new BrowserStorage(database)); await recovered.init();
    expect((await recovered.getRun(created.run.id))?.status).toBe("interrupted");
  });
});
