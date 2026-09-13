import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ModelRef,
  OrchestrationResult,
  RunEventRecord,
} from "@conclave/core";
import { FileStateStore } from "./file-store.js";
import { inspectRun } from "./run-inspection.js";

const roots: string[] = [];
const model: ModelRef = {
  provider: "mock",
  model: "mock-gpt",
  label: "GPT (mock)",
};

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "conclave-inspection-"));
  roots.push(root);
  const store = new FileStateStore(root);
  await store.init();
  return store;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("run inspection", () => {
  it("summarizes archived attempts, lineage, timing, and usage", async () => {
    const store = await makeStore();
    const created = await store.createRun({
      mode: "single",
      prompt: "Inspect me",
      participants: [model],
      budget: { maxCalls: 1, maxRounds: 1 },
    });
    const runId = created.run.id;

    const first: RunEventRecord[] = [
      {
        seq: 1,
        attempt: 1,
        at: "2026-09-13T00:00:00.000Z",
        event: { type: "run_started", runId, mode: "single" },
      },
      {
        seq: 2,
        attempt: 1,
        at: "2026-09-13T00:00:01.000Z",
        event: {
          type: "step_started",
          runId,
          stepId: "answer-1",
          kind: "answer",
          model,
        },
      },
      {
        seq: 3,
        attempt: 1,
        at: "2026-09-13T00:00:02.000Z",
        event: {
          type: "run_usage",
          runId,
          usage: {
            callsStarted: 1,
            callsCompleted: 0,
            inputTokens: 10,
            outputTokens: 3,
            tokenReports: 1,
          },
        },
      },
      {
        seq: 4,
        attempt: 1,
        at: "2026-09-13T00:00:03.000Z",
        event: { type: "error", runId, message: "temporary failure" },
      },
    ];
    for (const record of first) await store.appendRunEvent(record);
    await store.updateRun(runId, {
      status: "failed",
      error: "temporary failure",
    });
    await store.prepareResume(runId);

    const result: OrchestrationResult = {
      mode: "single",
      steps: [
        {
          id: "answer-1",
          kind: "answer",
          model,
          content: "Recovered answer",
          dependsOn: [],
        },
      ],
      final: "Recovered answer",
    };
    const second: RunEventRecord[] = [
      {
        seq: 1,
        attempt: 2,
        at: "2026-09-13T00:01:00.000Z",
        event: { type: "run_started", runId, mode: "single" },
      },
      {
        seq: 2,
        attempt: 2,
        at: "2026-09-13T00:01:01.000Z",
        event: {
          type: "step_started",
          runId,
          stepId: "answer-1",
          kind: "answer",
          model,
          dependsOn: [],
        },
      },
      {
        seq: 3,
        attempt: 2,
        at: "2026-09-13T00:01:02.000Z",
        event: {
          type: "usage",
          runId,
          stepId: "answer-1",
          inputTokens: 20,
          outputTokens: 7,
        },
      },
      {
        seq: 4,
        attempt: 2,
        at: "2026-09-13T00:01:04.000Z",
        event: { type: "step_completed", runId, step: result.steps[0] },
      },
      {
        seq: 5,
        attempt: 2,
        at: "2026-09-13T00:01:05.000Z",
        event: {
          type: "run_usage",
          runId,
          usage: {
            callsStarted: 1,
            callsCompleted: 1,
            inputTokens: 20,
            outputTokens: 7,
            tokenReports: 1,
          },
        },
      },
      {
        seq: 6,
        attempt: 2,
        at: "2026-09-13T00:01:06.000Z",
        event: { type: "run_completed", runId, result },
      },
    ];
    for (const record of second) await store.appendRunEvent(record);
    await store.completeRun(runId, result);

    const run = await store.getRun(runId);
    expect(run).not.toBeNull();
    const inspection = await inspectRun(store, run!);

    expect(inspection.attempts).toHaveLength(2);
    expect(inspection.attempts[0]).toMatchObject({
      attempt: 1,
      status: "failed",
      eventCount: 4,
      error: "temporary failure",
    });
    expect(inspection.attempts[0]?.steps[0]).toMatchObject({
      id: "answer-1",
      status: "failed",
      durationMs: 2000,
    });

    expect(inspection.attempts[1]).toMatchObject({
      attempt: 2,
      status: "completed",
      eventCount: 6,
      durationMs: 6000,
      usage: {
        callsStarted: 1,
        callsCompleted: 1,
        inputTokens: 20,
        outputTokens: 7,
      },
    });
    expect(inspection.attempts[1]?.steps[0]).toMatchObject({
      id: "answer-1",
      status: "completed",
      inputTokens: 20,
      outputTokens: 7,
      durationMs: 3000,
      dependsOn: [],
    });
  });

  it("accumulates per-step token usage across retry attempts", async () => {
    const store = await makeStore();
    const created = await store.createRun({
      mode: "single",
      prompt: "Retry usage",
      participants: [model],
      budget: { maxCalls: 2, maxRounds: 1 },
    });
    const runId = created.run.id;
    const result: OrchestrationResult = {
      mode: "single",
      steps: [
        {
          id: "answer-1",
          kind: "answer",
          model,
          content: "Recovered",
          dependsOn: [],
        },
      ],
      final: "Recovered",
    };
    const records: RunEventRecord[] = [
      {
        seq: 1,
        attempt: 1,
        at: "2026-09-13T00:10:00.000Z",
        event: { type: "run_started", runId, mode: "single" },
      },
      {
        seq: 2,
        attempt: 1,
        at: "2026-09-13T00:10:01.000Z",
        event: {
          type: "step_started",
          runId,
          stepId: "answer-1",
          kind: "answer",
          model,
        },
      },
      {
        seq: 3,
        attempt: 1,
        at: "2026-09-13T00:10:02.000Z",
        event: {
          type: "usage",
          runId,
          stepId: "answer-1",
          inputTokens: 10,
          outputTokens: 4,
        },
      },
      {
        seq: 4,
        attempt: 1,
        at: "2026-09-13T00:10:03.000Z",
        event: {
          type: "step_retrying",
          runId,
          stepId: "answer-1",
          attempt: 2,
          message: "temporary connection unavailable",
        },
      },
      {
        seq: 5,
        attempt: 1,
        at: "2026-09-13T00:10:04.000Z",
        event: {
          type: "usage",
          runId,
          stepId: "answer-1",
          inputTokens: 6,
          outputTokens: 1,
        },
      },
      {
        seq: 6,
        attempt: 1,
        at: "2026-09-13T00:10:05.000Z",
        event: {
          type: "usage",
          runId,
          stepId: "answer-1",
          inputTokens: 6,
          outputTokens: 3,
        },
      },
      {
        seq: 7,
        attempt: 1,
        at: "2026-09-13T00:10:06.000Z",
        event: { type: "step_completed", runId, step: result.steps[0] },
      },
      {
        seq: 8,
        attempt: 1,
        at: "2026-09-13T00:10:07.000Z",
        event: { type: "run_completed", runId, result },
      },
    ];
    for (const record of records) await store.appendRunEvent(record);
    await store.completeRun(runId, result);

    const run = await store.getRun(runId);
    const inspection = await inspectRun(store, run!);
    expect(inspection.attempts[0]?.steps[0]).toMatchObject({
      id: "answer-1",
      status: "completed",
      attempts: 2,
      inputTokens: 16,
      outputTokens: 7,
    });
  });

  it("marks the originating workflow step failed and aborted siblings cancelled", async () => {
    const store = await makeStore();
    const created = await store.createRun({
      mode: "custom",
      prompt: "Inspect branch failure",
      participants: [model],
      workflow: {
        name: "Failure inspection",
        outputNodeId: "final",
        nodes: [
          {
            id: "bad",
            kind: "answer",
            model: { type: "participant", index: 0 },
            promptTemplate: "bad",
          },
          {
            id: "slow",
            kind: "answer",
            model: { type: "participant", index: 0 },
            promptTemplate: "slow",
          },
          {
            id: "final",
            kind: "synthesis",
            model: { type: "participant", index: 0 },
            dependsOn: ["bad", "slow"],
            promptTemplate: "final",
          },
        ],
      },
      budget: { maxCalls: 3, maxRounds: 1 },
    });
    const runId = created.run.id;

    const records: RunEventRecord[] = [
      {
        seq: 1,
        attempt: 1,
        at: "2026-09-13T01:00:00.000Z",
        event: { type: "run_started", runId, mode: "custom" },
      },
      {
        seq: 2,
        attempt: 1,
        at: "2026-09-13T01:00:01.000Z",
        event: {
          type: "step_started",
          runId,
          stepId: "bad",
          kind: "answer",
          model,
        },
      },
      {
        seq: 3,
        attempt: 1,
        at: "2026-09-13T01:00:01.100Z",
        event: {
          type: "step_started",
          runId,
          stepId: "slow",
          kind: "answer",
          model,
        },
      },
      {
        seq: 4,
        attempt: 1,
        at: "2026-09-13T01:00:02.000Z",
        event: {
          type: "error",
          runId,
          stepId: "bad",
          message: "branch exploded",
        },
      },
      {
        seq: 5,
        attempt: 1,
        at: "2026-09-13T01:00:02.100Z",
        event: { type: "error", runId, message: "branch exploded" },
      },
    ];
    for (const record of records) await store.appendRunEvent(record);
    await store.updateRun(runId, {
      status: "failed",
      error: "branch exploded",
    });

    const run = await store.getRun(runId);
    const inspection = await inspectRun(store, run!);
    const attempt = inspection.attempts[0]!;

    expect(attempt.status).toBe("failed");
    expect(attempt.steps.find((step) => step.id === "bad")).toMatchObject({
      status: "failed",
      durationMs: 1000,
    });
    expect(attempt.steps.find((step) => step.id === "slow")).toMatchObject({
      status: "cancelled",
      durationMs: 1000,
    });
  });
});
