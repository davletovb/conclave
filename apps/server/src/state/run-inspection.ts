import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  RunAttemptInspection,
  RunEventRecord,
  RunInspection,
  RunStatus,
  RunStepInspection,
  StoredRun,
} from "@conclave/core";
import { emptyRunUsage } from "@conclave/core";
import type { FileStateStore } from "./file-store.js";

function durationMs(start?: string, end?: string) {
  if (!start || !end) return undefined;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

async function readRecords(path: string) {
  try {
    const raw = await readFile(path, "utf8");
    const records: RunEventRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as RunEventRecord);
      } catch {
        // Preserve all complete records if the process stopped during a final append.
      }
    }
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function allRecords(dataDir: string, runId: string) {
  const runsDir = join(dataDir, "runs");
  const entries = await readdir(runsDir, { withFileTypes: true });
  const names = entries
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name === `${runId}.ndjson` || name.startsWith(`${runId}.attempt-`) && name.endsWith(".ndjson"));

  const records = (await Promise.all(names.map(name => readRecords(join(runsDir, name))))).flat();
  return records.sort((a, b) => a.attempt - b.attempt || a.seq - b.seq);
}

function attemptStatus(records: RunEventRecord[], fallback: RunStatus): RunStatus {
  const terminal = [...records].reverse().find(record => (
    record.event.type === "run_completed"
    || record.event.type === "run_cancelled"
    || record.event.type === "error"
  ));
  if (terminal?.event.type === "run_completed") return "completed";
  if (terminal?.event.type === "run_cancelled") return "cancelled";
  if (terminal?.event.type === "error") return "failed";
  return fallback;
}

function finishRunningSteps(
  steps: Map<string, RunStepInspection>,
  status: "failed" | "cancelled",
  at: string,
) {
  for (const step of steps.values()) {
    if (step.status !== "running") continue;
    step.status = status;
    step.completedAt = at;
    step.durationMs = durationMs(step.startedAt, at);
  }
}

function summarizeAttempt(run: StoredRun, attempt: number, records: RunEventRecord[]): RunAttemptInspection {
  const steps = new Map<string, RunStepInspection>();
  let usage = emptyRunUsage();
  let rateLimit = undefined as RunAttemptInspection["rateLimit"];
  let error = undefined as string | undefined;
  let terminalAt: string | undefined;

  for (const record of records) {
    const event = record.event;
    if (event.type === "run_usage") usage = { ...event.usage };
    if (event.type === "rate_limit") rateLimit = event.notice;

    if (event.type === "step_started") {
      steps.set(event.stepId, {
        id: event.stepId,
        kind: event.kind,
        model: event.model,
        dependsOn: [...(event.dependsOn ?? [])],
        status: "running",
        startedAt: record.at,
      });
    } else if (event.type === "usage") {
      const step = steps.get(event.stepId) ?? {
        id: event.stepId,
        dependsOn: [],
        status: "running" as const,
      };
      if (event.inputTokens !== undefined) step.inputTokens = event.inputTokens;
      if (event.outputTokens !== undefined) step.outputTokens = event.outputTokens;
      steps.set(event.stepId, step);
    } else if (event.type === "step_completed") {
      const existing = steps.get(event.step.id) ?? {
        id: event.step.id,
        dependsOn: [...(event.step.dependsOn ?? [])],
        status: "running" as const,
      };
      existing.kind = event.step.kind;
      existing.model = event.step.model;
      existing.dependsOn = [...(event.step.dependsOn ?? existing.dependsOn)];
      existing.status = "completed";
      existing.completedAt = record.at;
      existing.durationMs = durationMs(existing.startedAt, record.at);
      steps.set(event.step.id, existing);
    } else if (event.type === "error") {
      error = event.message;
      terminalAt = record.at;
      if (event.stepId) {
        const existing = steps.get(event.stepId) ?? {
          id: event.stepId,
          dependsOn: [],
          status: "running" as const,
        };
        existing.status = "failed";
        existing.completedAt = record.at;
        existing.durationMs = durationMs(existing.startedAt, record.at);
        steps.set(event.stepId, existing);
      }
      // A top-level orchestration error is terminal for the attempt. Any
      // provider step still open at that point did not complete successfully.
      finishRunningSteps(steps, "failed", record.at);
    } else if (event.type === "run_cancelled") {
      error = event.message;
      terminalAt = record.at;
      finishRunningSteps(steps, "cancelled", record.at);
    } else if (event.type === "run_completed") {
      terminalAt = record.at;
    }
  }

  const isCurrent = attempt === run.attempt;
  const fallback: RunStatus = isCurrent ? run.status : "interrupted";
  const status = attemptStatus(records, fallback);
  const startedAt = records[0]?.at ?? (isCurrent ? run.createdAt : undefined);
  const completedAt = terminalAt ?? (!isCurrent && records.length > 0 ? records.at(-1)?.at : undefined);

  return {
    attempt,
    status,
    startedAt,
    completedAt,
    durationMs: durationMs(startedAt, completedAt),
    eventCount: records.length,
    usage,
    steps: [...steps.values()],
    rateLimit,
    error: error ?? (isCurrent ? run.error : status === "interrupted" ? "Attempt was interrupted before a terminal event was written." : undefined),
  };
}

export async function inspectRun(store: FileStateStore, run: StoredRun): Promise<RunInspection> {
  const records = await allRecords(store.dataDir, run.id);
  const grouped = new Map<number, RunEventRecord[]>();
  for (const record of records) {
    const group = grouped.get(record.attempt) ?? [];
    group.push(record);
    grouped.set(record.attempt, group);
  }
  if (!grouped.has(run.attempt)) grouped.set(run.attempt, []);

  const attempts = [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([attempt, attemptRecords]) => summarizeAttempt(run, attempt, attemptRecords));

  return { run, attempts };
}
