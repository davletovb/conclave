import type { OrchestrationStep, RunStepInspection } from "@conclave/core";

export type StepStatus =
  | "pending"
  | "working"
  | "streaming"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "running";

/**
 * What a council step is doing right now, from three sources that can disagree:
 * the live event stream, the locally tracked completions, and the persisted
 * inspection record (which only exists once the inspector has been opened).
 * A terminal verdict from the durable record always wins.
 */
export function stepStatus(
  step: OrchestrationStep,
  meta: RunStepInspection | undefined,
  completedStepIds: string[],
  loading: boolean,
): StepStatus {
  if (meta?.status === "failed" || meta?.status === "cancelled") return meta.status;
  if (completedStepIds.includes(step.id) || meta?.status === "completed") return "completed";
  if (loading) return step.content ? "streaming" : "working";
  return step.content ? "partial" : "pending";
}
