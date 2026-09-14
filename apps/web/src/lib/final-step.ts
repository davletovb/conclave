import type { OrchestrationStep } from "@conclave/core";

/**
 * The step whose output *is* the final answer, so the reader is never shown the
 * same text twice — once assembling itself in council work, once as the answer.
 *
 * The orchestrator marks it, which is the only reliable source: the finalizing
 * step is not always the one the mode's role name suggests. Consensus, for
 * instance, is finalized by a verifier's review rather than by the consensus
 * builder's synthesis.
 *
 * Matching on content is the fallback for runs saved before the flag existed,
 * and for a degraded run where the step meant to finalize failed and an earlier
 * one became the answer.
 *
 * Undefined when no single step produced the answer: Compare joins its
 * participants, and a failed finalization falls back to assembled prose.
 */
export function finalAnswerStepId(steps: OrchestrationStep[], final?: string) {
  const marked = steps.find(step => step.final);
  if (marked) return marked.id;

  const answer = final?.trim();
  if (!answer) return undefined;
  return [...steps].reverse().find(step => step.content.trim() === answer)?.id;
}

/** What the answer area is showing, once there is a finalizing step to show. */
export type AnswerPhase =
  /** the run finished: the whole answer, and it can be copied */
  | "done"
  /** the finalizing step is mid-write */
  | "streaming"
  /** it finished writing, but the run has other work still in flight */
  | "written"
  /** the run was stopped or interrupted: this is as far as the model got */
  | "stopped";

/**
 * A custom workflow runs every node, not only the ancestors of its output node,
 * so a sidecar can still be running after the answer is whole. Keying the
 * byline off the run rather than off the step it names would then leave
 * "…is writing…" over a finished answer until the sidecar landed.
 */
export function answerPhase(input: { hasResult: boolean; loading: boolean; finalStepComplete: boolean }): AnswerPhase {
  if (input.hasResult) return "done";
  if (!input.loading) return "stopped";
  return input.finalStepComplete ? "written" : "streaming";
}

/**
 * How far the newest output is from where the reader is held, in pixels:
 * negative means it is above them, positive below.
 *
 * During a run the answer is written *above* council work, so the newest text
 * is not at the bottom of the surface. Both the auto-follow and the check for
 * whether the reader has scrolled away read this, so they cannot disagree about
 * what "latest" means — and following the answer while measuring distance to
 * the bottom would switch following off after a single frame.
 */
export function followDistance(input: {
  /** the answer's bottom edge in viewport coordinates, absent when there is none */
  answerBottom?: number;
  viewBottom: number;
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  /** breathing room kept below the answer's last line */
  margin?: number;
}) {
  if (input.answerBottom !== undefined) return input.answerBottom + (input.margin ?? 24) - input.viewBottom;
  return input.scrollHeight - input.scrollTop - input.clientHeight;
}
