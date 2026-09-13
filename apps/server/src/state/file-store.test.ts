import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRef } from "@conclave/core";
import { FileStateStore } from "./file-store.js";

const tempDirs: string[] = [];
const participant: ModelRef = { provider: "mock", model: "mock-gpt", label: "GPT (mock)" };

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), "conclave-state-"));
  tempDirs.push(dir);
  const store = new FileStateStore(dir);
  await store.init();
  return { dir, store };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("FileStateStore", () => {
  it("persists conversations and restores them from disk", async () => {
    const { dir, store } = await tempStore();
    const created = await store.createRun({
      mode: "single",
      prompt: "Remember this architecture decision",
      participants: [participant],
    });

    await store.completeRun(created.run.id, {
      mode: "single",
      steps: [{ id: "answer-1", kind: "answer", model: participant, content: "Use local persistence." }],
      final: "Use local persistence.",
    });

    const reopened = new FileStateStore(dir);
    await reopened.init();
    const conversation = await reopened.getConversation(created.conversation.id);
    expect(conversation?.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(conversation?.messages.at(-1)?.content).toBe("Use local persistence.");
  });

  it("keeps each assistant response beside its user turn when runs finish out of order", async () => {
    const { store } = await tempStore();
    const first = await store.createRun({
      mode: "single",
      prompt: "Question A",
      participants: [participant],
    });
    const second = await store.createRun({
      mode: "single",
      prompt: "Question B",
      participants: [participant],
    }, first.conversation.id);

    await store.completeRun(second.run.id, {
      mode: "single",
      steps: [{ id: "answer-1", kind: "answer", model: participant, content: "Answer B" }],
      final: "Answer B",
    });
    await store.completeRun(first.run.id, {
      mode: "single",
      steps: [{ id: "answer-1", kind: "answer", model: participant, content: "Answer A" }],
      final: "Answer A",
    });

    const conversation = await store.getConversation(first.conversation.id);
    expect(conversation?.messages.map(message => `${message.role}:${message.content}`)).toEqual([
      "user:Question A",
      "assistant:Answer A",
      "user:Question B",
      "assistant:Answer B",
    ]);
    expect(conversation?.lastRunId).toBe(second.run.id);
  });

  it("moves the attempt start timestamp on resume while createdAt stays put", async () => {
    const { store } = await tempStore();
    const created = await store.createRun({
      mode: "single",
      prompt: "Long running question",
      participants: [participant],
    });
    expect(created.run.attemptStartedAt).toBe(created.run.createdAt);

    await store.updateRun(created.run.id, { status: "interrupted", error: "stopped" });
    await new Promise(resolve => setTimeout(resolve, 5));
    const resumed = await store.prepareResume(created.run.id);

    // Elapsed time is measured from the current attempt, so a run resumed
    // hours later must not report the whole wall-clock gap.
    expect(resumed.createdAt).toBe(created.run.createdAt);
    expect(resumed.attempt).toBe(2);
    expect(Date.parse(resumed.attemptStartedAt!)).toBeGreaterThan(Date.parse(resumed.createdAt));
  });

  it("reconciles a durable run_completed event after a crash before state commit", async () => {
    const { dir, store } = await tempStore();
    const created = await store.createRun({
      mode: "single",
      prompt: "Do not recompute me",
      participants: [participant],
    });
    const result = {
      mode: "single" as const,
      steps: [{ id: "answer-1", kind: "answer" as const, model: participant, content: "Already finished" }],
      final: "Already finished",
    };
    await store.updateRun(created.run.id, { status: "running" });
    await store.appendRunEvent({
      seq: 1,
      attempt: 1,
      at: new Date().toISOString(),
      event: { type: "run_completed", runId: created.run.id, result },
    });

    const reopened = new FileStateStore(dir);
    await reopened.init();
    const run = await reopened.getRun(created.run.id);
    const conversation = await reopened.getConversation(created.conversation.id);
    expect(run?.status).toBe("completed");
    expect(run?.result?.final).toBe("Already finished");
    expect(conversation?.messages.map(message => `${message.role}:${message.content}`)).toEqual([
      "user:Do not recompute me",
      "assistant:Already finished",
    ]);
  });

  it("marks in-flight runs interrupted after a server restart", async () => {
    const { dir, store } = await tempStore();
    const created = await store.createRun({
      mode: "single",
      prompt: "Long running question",
      participants: [participant],
    });
    await store.updateRun(created.run.id, { status: "running" });

    const reopened = new FileStateStore(dir);
    await reopened.init();
    const run = await reopened.getRun(created.run.id);
    expect(run?.status).toBe("interrupted");
    expect(run?.error).toContain("Resume");
  });

  it("increments attempts and clears persisted events when resuming", async () => {
    const { store } = await tempStore();
    const created = await store.createRun({
      mode: "single",
      prompt: "Retry me",
      participants: [participant],
    });
    await store.updateRun(created.run.id, { status: "failed", error: "temporary failure" });
    await store.appendRunEvent({
      seq: 1,
      attempt: 1,
      at: new Date().toISOString(),
      event: { type: "error", runId: created.run.id, message: "temporary failure" },
    });

    const resumed = await store.prepareResume(created.run.id);
    expect(resumed.status).toBe("queued");
    expect(resumed.attempt).toBe(2);
    expect(await store.readRunEvents(created.run.id)).toEqual([]);
  });

  it("keeps persisted conversation data private to the local account", async () => {
    if (process.platform === "win32") return;
    const { dir, store } = await tempStore();
    const created = await store.createRun({
      mode: "single",
      prompt: "Private prompt",
      participants: [participant],
    });
    await store.appendRunEvent({
      seq: 1,
      attempt: 1,
      at: new Date().toISOString(),
      event: { type: "run_started", runId: created.run.id, mode: "single" },
    });

    const permissions = async (path: string) => (await stat(path)).mode & 0o777;
    expect(await permissions(dir)).toBe(0o700);
    expect(await permissions(join(dir, "runs"))).toBe(0o700);
    expect(await permissions(join(dir, "state.json"))).toBe(0o600);
    expect(await permissions(join(dir, "runs", `${created.run.id}.ndjson`))).toBe(0o600);
  });
});
