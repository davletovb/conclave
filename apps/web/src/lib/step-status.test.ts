import { describe, expect, it } from "vitest";
import type { ModelRef, OrchestrationStep, RunStepInspection } from "@conclave/core";
import { stepStatus } from "./step-status";

const model: ModelRef = { provider: "mock", model: "mock-gpt", label: "GPT (mock)" };
const step = (content = ""): OrchestrationStep => ({ id: "answer-1", kind: "answer", model, content });
const meta = (status: RunStepInspection["status"]): RunStepInspection => ({
  id: "answer-1",
  dependsOn: [],
  status,
});

describe("stepStatus", () => {
  it("separates waiting from streaming while a run is live", () => {
    expect(stepStatus(step(), undefined, [], true)).toBe("working");
    expect(stepStatus(step("partial text"), undefined, [], true)).toBe("streaming");
  });

  it("marks a finished step completed from either source", () => {
    expect(stepStatus(step("done"), undefined, ["answer-1"], true)).toBe("completed");
    expect(stepStatus(step("done"), meta("completed"), [], false)).toBe("completed");
  });

  it("lets a durable failure override local completion tracking", () => {
    expect(stepStatus(step("half"), meta("failed"), ["answer-1"], false)).toBe("failed");
    expect(stepStatus(step("half"), meta("cancelled"), ["answer-1"], true)).toBe("cancelled");
  });

  it("distinguishes an abandoned partial from a step that never started", () => {
    expect(stepStatus(step("half"), undefined, [], false)).toBe("partial");
    expect(stepStatus(step(), undefined, [], false)).toBe("pending");
  });
});
