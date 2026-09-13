import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRef } from "@conclave/core";
import { MockProvider } from "../providers/mock.js";
import { Orchestrator } from "../orchestrator.js";
import { FileStateStore } from "./file-store.js";
import { RunManager } from "./run-manager.js";

const tempDirs: string[] = [];
const participant: ModelRef = { provider: "mock", model: "mock-gpt", label: "GPT (mock)" };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeManager() {
  const dir = await mkdtemp(join(tmpdir(), "conclave-manager-"));
  tempDirs.push(dir);
  const provider = new MockProvider();
  const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));
  const store = new FileStateStore(dir);
  const manager = new RunManager(orchestrator, store);
  await manager.init();
  return { manager, store };
}

async function waitForTerminal(manager: RunManager, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await manager.getRun(runId);
    if (run && ["completed", "failed", "interrupted"].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("run did not reach a terminal state");
}

describe("RunManager", () => {
  it("continues a run independently and persists its final conversation message", async () => {
    const { manager } = await makeManager();
    const started = await manager.start({
      request: {
        mode: "single",
        prompt: "Persist this run",
        participants: [participant],
      },
    });

    const run = await waitForTerminal(manager, started.runId);
    expect(run.status).toBe("completed");
    expect(run.result?.final).toContain("Persist this run");

    const conversation = await manager.getConversation(started.conversationId);
    expect(conversation?.messages).toHaveLength(2);
    expect(conversation?.messages.map(message => message.role)).toEqual(["user", "assistant"]);

    const events = await manager.events(started.runId);
    expect(events[0]?.event.type).toBe("run_started");
    expect(events.at(-1)?.event.type).toBe("run_completed");
    expect(events.map(record => record.seq)).toEqual(events.map((_, index) => index + 1));
  });

  it("feeds previous conversation turns back into the next run", async () => {
    const { manager } = await makeManager();
    const first = await manager.start({
      request: {
        mode: "single",
        prompt: "First question",
        participants: [participant],
      },
    });
    await waitForTerminal(manager, first.runId);

    const second = await manager.start({
      conversationId: first.conversationId,
      request: {
        mode: "single",
        prompt: "Second question",
        participants: [participant],
      },
    });
    await waitForTerminal(manager, second.runId);

    const conversation = await manager.getConversation(first.conversationId);
    expect(conversation?.messages.map(message => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("rejects overlapping runs in the same conversation", async () => {
    const { manager } = await makeManager();
    const first = await manager.start({
      request: {
        mode: "single",
        prompt: "First active question",
        participants: [participant],
      },
    });

    await expect(manager.start({
      conversationId: first.conversationId,
      request: {
        mode: "single",
        prompt: "Overlapping question",
        participants: [participant],
      },
    })).rejects.toThrow("already has an active run");

    await waitForTerminal(manager, first.runId);

    const next = await manager.start({
      conversationId: first.conversationId,
      request: {
        mode: "single",
        prompt: "Question after completion",
        participants: [participant],
      },
    });
    const completed = await waitForTerminal(manager, next.runId);
    expect(completed.status).toBe("completed");
  });
});
