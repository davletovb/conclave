import { describe, expect, it } from "vitest";
import type { ModelRef, ProviderRequest } from "@conclave/core";
import { MockProvider } from "./providers/mock.js";
import { Orchestrator } from "./orchestrator.js";

const provider = new MockProvider();
const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));
const participants: ModelRef[] = [
  { provider: "mock", model: "mock-gpt", label: "GPT (mock)" },
  { provider: "mock", model: "mock-claude", label: "Claude (mock)" },
  { provider: "mock", model: "mock-grok", label: "Grok (mock)" },
];

class CountingMockProvider extends MockProvider {
  calls = 0;

  override async generate(request: ProviderRequest) {
    this.calls += 1;
    return super.generate(request);
  }
}

describe("Orchestrator", () => {
  it("keeps panel answers independent before synthesis", async () => {
    const result = await orchestrator.run({ mode: "panel", prompt: "Choose an architecture", participants });
    expect(result.steps.filter(step => step.kind === "answer")).toHaveLength(3);
    expect(result.steps.at(-1)?.kind).toBe("synthesis");
    expect(result.final.length).toBeGreaterThan(0);
  });

  it("bounds debate rounds", async () => {
    const result = await orchestrator.run({ mode: "debate", prompt: "Which option is safer?", participants, maxRounds: 99 });
    expect(result.steps.filter(step => step.kind === "critique")).toHaveLength(9);
    expect(result.steps.at(-1)?.kind).toBe("synthesis");
  });

  it("requires exactly one participant in single mode", async () => {
    await expect(orchestrator.run({
      mode: "single",
      prompt: "Answer once",
      participants,
    })).rejects.toThrow("Single mode requires exactly one participant");
  });

  it("critic-revise only calls the author, critic, then author again", async () => {
    const countingProvider = new CountingMockProvider();
    const countingOrchestrator = new Orchestrator(new Map([[countingProvider.id, countingProvider]]));
    const result = await countingOrchestrator.run({
      mode: "critic-revise",
      prompt: "Review this architecture",
      participants,
    });

    expect(countingProvider.calls).toBe(3);
    expect(result.steps.map(step => step.kind)).toEqual(["answer", "critique", "revision"]);
  });
});
