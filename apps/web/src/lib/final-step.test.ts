import { describe, expect, it } from "vitest";
import type { OrchestrationStep } from "@conclave/core";
import { answerPhase, finalAnswerStepId, followDistance } from "./final-step";

const model = { provider: "mock" as const, model: "mock-gpt", label: "GPT (mock)" };
const step = (id: string, content: string, extra: Partial<OrchestrationStep> = {}): OrchestrationStep =>
  ({ id, kind: "research", model, content, ...extra });

describe("finalAnswerStepId", () => {
  it("takes the orchestrator's mark, wherever it sits", () => {
    const steps = [
      step("research-1", "one"),
      step("research-2", "two"),
      step("synthesis-1", "the answer", { kind: "synthesis", final: true }),
    ];
    expect(finalAnswerStepId(steps, "the answer")).toBe("synthesis-1");
  });

  it("trusts the mark over the text, so a repeated answer is not mistaken for it", () => {
    // Consensus finalizes with a verifier's review, not with the consensus
    // builder's synthesis — and a model can echo an earlier step verbatim.
    const steps = [
      step("synthesis-1", "same text", { kind: "synthesis" }),
      step("review-1", "same text", { kind: "review", final: true }),
    ];
    expect(finalAnswerStepId(steps, "same text")).toBe("review-1");
  });

  it("falls back to the answer's text for runs saved before the mark existed", () => {
    const steps = [step("research-1", "one"), step("synthesis-1", "the answer", { kind: "synthesis" })];
    expect(finalAnswerStepId(steps, "the answer")).toBe("synthesis-1");
    // whitespace the store may have trimmed either side of
    expect(finalAnswerStepId(steps, "  the answer\n")).toBe("synthesis-1");
  });

  it("picks the last match when an unmarked run repeats itself", () => {
    const steps = [step("answer-1", "same"), step("revision-1", "same", { kind: "revision" })];
    expect(finalAnswerStepId(steps, "same")).toBe("revision-1");
  });

  it("finds nothing when no single step produced the answer", () => {
    const steps = [step("answer-1", "one"), step("answer-2", "two")];
    // Compare joins its participants
    expect(finalAnswerStepId(steps, "one\n\n---\n\ntwo")).toBeUndefined();
    // a degraded run falls back to assembled prose
    expect(finalAnswerStepId(steps, "Conclave could not complete panel synthesis.")).toBeUndefined();
    // and mid-stream there is no answer to compare against
    expect(finalAnswerStepId(steps)).toBeUndefined();
    expect(finalAnswerStepId(steps, "   ")).toBeUndefined();
  });

  it("does not match an empty step against an empty answer", () => {
    expect(finalAnswerStepId([step("answer-1", "")], "")).toBeUndefined();
  });

  it("finds the mark while the step is still streaming and empty", () => {
    // This is the case the answer area needs: the step has started, its text
    // has not arrived, and it must already be kept out of council work.
    const steps = [step("research-1", "one"), step("synthesis-1", "", { kind: "synthesis", final: true })];
    expect(finalAnswerStepId(steps)).toBe("synthesis-1");
  });
});

describe("answerPhase", () => {
  const phase = (loading: boolean, finalStepComplete: boolean, hasResult = false) =>
    answerPhase({ hasResult, loading, finalStepComplete });

  it("names the run's own state, not the step's, once there is a result", () => {
    expect(phase(true, false, true)).toBe("done");
    expect(phase(false, true, true)).toBe("done");
  });

  it("says a model is writing only while it is", () => {
    expect(phase(true, false)).toBe("streaming");
  });

  it("stops claiming a write that has ended while the run has other work", () => {
    // A custom workflow runs every node, not only the ancestors of its output
    // node, so a sidecar can outlive the answer. Keying the byline off the run
    // would leave "…is writing…" over a finished answer until the sidecar
    // landed. This is the case the byline got wrong.
    expect(phase(true, true)).toBe("written");
  });

  it("calls a stopped run's output partial", () => {
    expect(phase(false, false)).toBe("stopped");
    expect(phase(false, true)).toBe("stopped");
  });
});

describe("followDistance", () => {
  const surface = { viewBottom: 800, scrollHeight: 4000, scrollTop: 1000, clientHeight: 700 };

  it("measures to the end of the surface when there is no answer", () => {
    expect(followDistance(surface)).toBe(2300);
  });

  it("measures to the answer's tail when there is one, in either direction", () => {
    // below the fold: scroll down to it
    expect(followDistance({ ...surface, answerBottom: 900 })).toBe(124);
    // above the reader, because they are down in council work: scroll up
    expect(followDistance({ ...surface, answerBottom: 400 })).toBe(-376);
  });

  it("settles at the negative margin, which is what keeps the tail on screen", () => {
    // the auto-follow drives this to zero, leaving the last line one margin
    // above the fold; anything that drove it to zero against the surface's
    // bottom instead would put the answer off screen entirely.
    expect(followDistance({ ...surface, answerBottom: 776 })).toBe(0);
    expect(followDistance({ ...surface, answerBottom: 800, margin: 0 })).toBe(0);
  });

  it("is near zero exactly when the reader is following, which is what onScroll tests", () => {
    const distances = [-79, 0, 79].map(offset => followDistance({ ...surface, answerBottom: 776 + offset }));
    expect(distances.every(distance => Math.abs(distance) < 80)).toBe(true);
    expect(Math.abs(followDistance({ ...surface, answerBottom: 776 - 80 }))).toBeGreaterThanOrEqual(80);
  });
});
