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
