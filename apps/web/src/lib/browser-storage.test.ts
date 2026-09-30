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

describe("BrowserStorage as a file store", () => {
  const fresh = () => new BrowserStorage(`conclave-files-${crypto.randomUUID()}`);
  const rows = (database: string, store: string) => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open(database);
    open.onsuccess = () => {
      const count = open.result.transaction(store, "readonly").objectStore(store).count();
      count.onsuccess = () => { open.result.close(); resolve(count.result); };
    };
    open.onerror = () => reject(open.error);
  });

  it("appends to a file that does not exist yet, and reads back every append in order", async () => {
    const storage = fresh();
    await expect(storage.readFile("runs/a.ndjson")).rejects.toMatchObject({ code: "ENOENT" });
    await storage.appendFile("runs/a.ndjson", "one\n");
    await storage.appendFile("runs/a.ndjson", "two\n");
    await storage.appendFile("runs/a.ndjson", "three\n");
    expect(await storage.readFile("runs/a.ndjson")).toBe("one\ntwo\nthree\n");
  });

  it("appends after a whole-file write, and a later write replaces both", async () => {
    const storage = fresh();
    await storage.writeFile("runs/b.ndjson", "head\n");
    await storage.appendFile("runs/b.ndjson", "tail\n");
    expect(await storage.readFile("runs/b.ndjson")).toBe("head\ntail\n");
    await storage.writeFile("runs/b.ndjson", "replaced\n");
    expect(await storage.readFile("runs/b.ndjson")).toBe("replaced\n");
    await storage.appendFile("runs/b.ndjson", "again\n");
    expect(await storage.readFile("runs/b.ndjson")).toBe("replaced\nagain\n");
  });

  it("lists a file once however it was written, and only the files directly in the directory", async () => {
    const storage = fresh();
    await storage.writeFile("runs/whole.json", "{}");
    await storage.appendFile("runs/log.ndjson", "x\n");
    await storage.appendFile("runs/log.ndjson", "y\n");
    await storage.writeFile("runs/both.ndjson", "a"); await storage.appendFile("runs/both.ndjson", "b");
    await storage.writeFile("runs/deeper/inner.json", "{}");
    await storage.writeFile("other/elsewhere.json", "{}");
    const names = (await storage.readdir("runs")).map(entry => entry.name).sort();
    expect(names).toEqual(["both.ndjson", "log.ndjson", "whole.json"]);
    expect((await storage.readdir("runs"))[0].isFile()).toBe(true);
  });

  it("renames, removes and truncates appended files as a whole", async () => {
    const storage = fresh();
    await storage.appendFile("runs/old.ndjson", "1\n"); await storage.appendFile("runs/old.ndjson", "2\n");
    await storage.writeFile("runs/target.ndjson", "will be replaced");
    await storage.rename("runs/old.ndjson", "runs/target.ndjson");
    expect(await storage.readFile("runs/target.ndjson")).toBe("1\n2\n");
    await expect(storage.readFile("runs/old.ndjson")).rejects.toMatchObject({ code: "ENOENT" });
    await storage.appendFile("runs/target.ndjson", "3\n");
    expect(await storage.readFile("runs/target.ndjson")).toBe("1\n2\n3\n");
    await storage.truncate("runs/target.ndjson", 4);
    expect(await storage.readFile("runs/target.ndjson")).toBe("1\n2\n");
    await storage.appendFile("runs/target.ndjson", "4\n");
    expect(await storage.readFile("runs/target.ndjson")).toBe("1\n2\n4\n");
    await storage.rm("runs/target.ndjson");
    await expect(storage.readFile("runs/target.ndjson")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await storage.readdir("runs")).toEqual([]);
    await expect(storage.rename("runs/missing", "runs/anywhere")).rejects.toThrow();
  });

  it("keeps every record of a version 1 database when it upgrades", async () => {
    const name = `conclave-legacy-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("records");
      open.onsuccess = () => {
        const tx = open.result.transaction("records", "readwrite");
        tx.objectStore("records").put("legacy conversation", "conclave/conversations/c1.json");
        tx.oncomplete = () => { open.result.close(); resolve(); };
      };
      open.onerror = () => reject(open.error);
    });
    const storage = new BrowserStorage(name);
    expect(await storage.readFile("conclave/conversations/c1.json")).toBe("legacy conversation");
    await storage.appendFile("conclave/runs/r1.ndjson", "event\n");
    expect(await storage.readFile("conclave/runs/r1.ndjson")).toBe("event\n");
  });

  it("appends a long event log without rewriting it: one small record per event", async () => {
    const database = `conclave-long-${crypto.randomUUID()}`;
    const storage = new BrowserStorage(database);
    const line = JSON.stringify({ seq: 0, event: { type: "text_delta", delta: "x".repeat(400) } }) + "\n";
    const started = Date.now();
    for (let i = 0; i < 3000; i++) await storage.appendFile("runs/long.ndjson", line);
    const elapsed = Date.now() - started;
    // Rewriting the whole log on each append would move about 600 MB in total and take far longer.
    expect(elapsed).toBeLessThan(15_000);
    expect((await storage.readFile("runs/long.ndjson")).length).toBe(line.length * 3000);
    expect(await rows(database, "chunks")).toBe(3000);
    expect(await rows(database, "records")).toBe(1); // just the counter, however long the log gets
  });
});

