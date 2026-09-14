import { describe, expect, it } from "vitest";
import type { OrchestrationStep } from "@conclave/core";
import { finalAnswerStepId } from "./final-step";

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
