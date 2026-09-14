import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRef, ProviderRequest, WorkflowGraph } from "@conclave/core";
import { MockProvider } from "../providers/mock.js";
import { Orchestrator } from "../orchestrator.js";
import { FileStateStore } from "./file-store.js";
import { RunManager } from "./run-manager.js";

const tempDirs: string[] = [];
const participant: ModelRef = { provider: "mock", model: "mock-gpt", label: "GPT (mock)" };

class CancellableMockProvider extends MockProvider {
  calls = 0;

  override async generate(request: ProviderRequest) {
    this.calls += 1;
    if (this.calls > 1) return super.generate(request);

    return new Promise<never>((_resolve, reject) => {
      const cancel = () => {
        const error = new Error("mock provider cancelled");
        error.name = "AbortError";
        reject(error);
      };
      if (request.signal?.aborted) return cancel();
      request.signal?.addEventListener("abort", cancel, { once: true });
    });
  }
}

class ReplayStallProvider extends MockProvider {
  calls = 0;
  aborted = 0;

  override async generate(request: ProviderRequest, emit?: (event: { type: "text_delta"; delta: string }) => void) {
    this.calls += 1;
    if (this.calls > 1) return super.generate(request);

    emit?.({ type: "text_delta", delta: "stale-partial" });
    return new Promise<never>((_resolve, reject) => {
      const abort = () => {
        this.aborted += 1;
        const error = new Error("replay stall aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (request.signal?.aborted) return abort();
      request.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeManager(
  provider: MockProvider = new MockProvider(),
  stepStallTimeoutMs?: number,
) {
  const dir = await mkdtemp(join(tmpdir(), "conclave-manager-"));
  tempDirs.push(dir);
  const orchestrator = new Orchestrator(
    new Map([[provider.id, provider]]),
    { stepStallTimeoutMs },
  );
  const store = new FileStateStore(dir);
  const manager = new RunManager(orchestrator, store);
  await manager.init();
  return { manager, store };
}

async function waitForTerminal(manager: RunManager, runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await manager.getRun(runId);
    if (run && ["completed", "failed", "interrupted", "cancelled"].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("run did not reach a terminal state");
}

async function waitForCalls(manager: RunManager, runId: string, minimum = 1) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await manager.getRun(runId);
    if ((run?.usage.callsStarted ?? 0) >= minimum) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("run did not start a provider call");
}

describe("RunManager", () => {
  it("never lets a conversation be deleted out from under a live run", async () => {
    const provider = new CancellableMockProvider();
    const { manager, store } = await makeManager(provider);
    const started = await manager.start({
      request: {
        mode: "single",
        prompt: "Hang on the first provider call",
        participants: [participant],
      },
    });

    await expect(manager.deleteConversation(started.conversationId)).rejects.toThrow(/already has an active run/i);
    expect(await manager.getConversation(started.conversationId)).not.toBeNull();
    expect(await manager.getRun(started.runId)).not.toBeNull();

    await manager.cancel(started.runId);
    await waitForTerminal(manager, started.runId);

    await manager.deleteConversation(started.conversationId);
    expect(await manager.getConversation(started.conversationId)).toBeNull();
    expect(await manager.getRun(started.runId)).toBeNull();
    expect(await store.readRunEvents(started.runId)).toEqual([]);
  });

  it("waits for terminal cancellation cleanup before deleting the conversation", async () => {
    const provider = new CancellableMockProvider();
    const { manager, store } = await makeManager(provider);
    const originalUpdateRun = store.updateRun.bind(store);

    let terminalRewriteStarted!: () => void;
    const terminalRewriteStartedPromise = new Promise<void>(resolve => {
      terminalRewriteStarted = resolve;
    });
    let releaseTerminalRewrite!: () => void;
    const releaseTerminalRewritePromise = new Promise<void>(resolve => {
      releaseTerminalRewrite = resolve;
    });
    let cancelledWrites = 0;

    store.updateRun = async (runId, patch) => {
      if (patch.status === "cancelled") {
        cancelledWrites += 1;
        if (cancelledWrites === 2) {
          terminalRewriteStarted();
          await releaseTerminalRewritePromise;
        }
      }
      return originalUpdateRun(runId, patch);
    };

    const started = await manager.start({
      request: {
        mode: "single",
        prompt: "Expose the terminal-state cleanup window",
        participants: [participant],
      },
    });

    await waitForCalls(manager, started.runId);
    await manager.cancel(started.runId);
    const cancelled = await waitForTerminal(manager, started.runId);
    expect(cancelled.status).toBe("cancelled");

    // The run_cancelled event has already made the run terminal, while execute()
    // is deliberately held on its final state write and still owns the
    // conversation reservation. This is the ordering that used to fail on CI.
    await terminalRewriteStartedPromise;

    let deletionState: "pending" | "resolved" | "rejected" = "pending";
    const deleting = manager.deleteConversation(started.conversationId);
    void deleting.then(
      () => { deletionState = "resolved"; },
      () => { deletionState = "rejected"; },
    );

    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(deletionState).toBe("pending");
      expect(await manager.getConversation(started.conversationId)).not.toBeNull();
    } finally {
      releaseTerminalRewrite();
    }

    await deleting;
    expect(await manager.getConversation(started.conversationId)).toBeNull();
    expect(await manager.getRun(started.runId)).toBeNull();
  });

  it("refuses to start a run against a conversation that is being deleted", async () => {
    const { manager } = await makeManager();
    const first = await manager.start({
      request: { mode: "single", prompt: "First turn", participants: [participant] },
    });
    await waitForTerminal(manager, first.runId);

    // The delete holds the conversation for its whole duration, so a run cannot
    // slip in between the guard and the store write and end up executing
    // against wiped state. The guard has to be what rejects the start: letting
    // it through and failing later in the store would already have created and
    // launched the run.
    const deleting = manager.deleteConversation(first.conversationId);
    await expect(manager.start({
      conversationId: first.conversationId,
      request: { mode: "single", prompt: "Racing turn", participants: [participant] },
    })).rejects.toThrow(/being deleted/i);
    await deleting;

    expect(await manager.getConversation(first.conversationId)).toBeNull();
    expect(await manager.listConversations()).toEqual([]);
  });


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
    expect(run.request.budget).toEqual({ maxCalls: 12, maxRounds: 1 });
    expect(run.usage).toMatchObject({ callsStarted: 1, callsCompleted: 1 });

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

  it("cancels an active provider call, persists the terminal event, and can resume", async () => {
    const provider = new CancellableMockProvider();
    const { manager } = await makeManager(provider);
    const started = await manager.start({
      request: {
        mode: "single",
        prompt: "Cancel the first attempt",
        participants: [participant],
        budget: { maxCalls: 1, maxRounds: 1 },
      },
    });

    await waitForCalls(manager, started.runId);
    await manager.cancel(started.runId);
    const cancelled = await waitForTerminal(manager, started.runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.usage.callsStarted).toBe(1);
    expect(cancelled.usage.callsCompleted).toBe(0);
    expect((await manager.events(started.runId)).some(record => record.event.type === "run_cancelled")).toBe(true);

    // Wait for the old task to release the conversation reservation before
    // starting the next attempt.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const resumed = await manager.resume(started.runId);
        const completed = await waitForTerminal(manager, resumed.runId);
        expect(completed.status).toBe("completed");
        expect(completed.attempt).toBe(2);
        expect(completed.usage).toMatchObject({ callsStarted: 1, callsCompleted: 1 });
        return;
      } catch (error) {
        if (!(error instanceof Error) || !/active run/i.test(error.message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    throw new Error("cancelled run never released its conversation reservation");
  });

  it("replays stalled-step recovery from a cursor without gaps or duplicates", async () => {
    const provider = new ReplayStallProvider();
    const { manager } = await makeManager(provider, 80);
    const started = await manager.start({
      request: {
        mode: "single",
        prompt: "Recover and replay",
        participants: [participant],
        budget: { maxCalls: 2, maxRounds: 1 },
      },
    });

    let firstDeltaSeq = 0;
    for (let attempt = 0; attempt < 100 && firstDeltaSeq === 0; attempt += 1) {
      const records = await manager.events(started.runId);
      firstDeltaSeq = records.find(record => record.event.type === "text_delta")?.seq ?? 0;
      if (!firstDeltaSeq) await new Promise(resolve => setTimeout(resolve, 2));
    }
    expect(firstDeltaSeq).toBeGreaterThan(0);

    const completed = await waitForTerminal(manager, started.runId);
    expect(completed.status).toBe("completed");
    expect(provider.calls).toBe(2);
    expect(provider.aborted).toBe(1);

    const replay = await manager.events(started.runId, firstDeltaSeq);
    const replayAgain = await manager.events(started.runId, firstDeltaSeq);
    expect(replay.map(record => record.seq)).toEqual(replayAgain.map(record => record.seq));
    expect(replay[0]?.seq).toBe(firstDeltaSeq + 1);
    expect(replay.some(record => record.event.type === "step_retrying")).toBe(true);
    expect(replay.at(-1)?.event.type).toBe("run_completed");

    const full = await manager.events(started.runId);
    expect(full.map(record => record.seq)).toEqual(full.map((_, index) => index + 1));
  });

  it("rejects invalid server-side budget values before creating a run", async () => {
    const { manager } = await makeManager();
    await expect(manager.start({
      request: {
        mode: "single",
        prompt: "Bad budget",
        participants: [participant],
        budget: { maxCalls: 0, maxRounds: 1 },
      },
    })).rejects.toThrow(/maxCalls/);
  });

  it("validates malformed custom workflows before persisting a conversation or run", async () => {
    const { manager } = await makeManager();
    const malformed = {
      name: "Malformed",
      outputNodeId: "bad",
      nodes: [null],
    } as unknown as WorkflowGraph;

    await expect(manager.start({
      request: {
        mode: "custom",
        prompt: "Reject before persistence",
        participants: [participant],
        workflow: malformed,
      },
    })).rejects.toThrow(/node must be an object/i);

    expect(await manager.listConversations()).toEqual([]);
  });
});
