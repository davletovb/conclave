import { describe, expect, it } from "vitest";
import type {
  ModelRef,
  OrchestrationStreamEvent,
  ProviderRequest,
  WorkflowGraph,
} from "@conclave/core";
import { MockProvider } from "./providers/mock.js";
import { Orchestrator } from "./orchestrator.js";

const participants: ModelRef[] = [
  { provider: "mock", model: "mock-gpt", label: "GPT (mock)" },
  { provider: "mock", model: "mock-claude", label: "Claude (mock)" },
];

class RecordingProvider extends MockProvider {
  calls: ProviderRequest[] = [];

  override async generate(request: ProviderRequest) {
    this.calls.push(request);
    return super.generate(request);
  }
}

const graph: WorkflowGraph = {
  name: "Parallel then synthesize",
  outputNodeId: "final",
  nodes: [
    {
      id: "left",
      kind: "answer",
      model: { type: "participant", index: 0 },
      promptTemplate: "Left analysis: {{prompt}}",
    },
    {
      id: "right",
      kind: "research",
      model: { type: "participant", index: 1 },
      promptTemplate: "Right analysis: {{prompt}}",
    },
    {
      id: "final",
      kind: "synthesis",
      model: { type: "synthesizer" },
      dependsOn: ["left", "right"],
      promptTemplate: "Question: {{prompt}}\n\nInputs:\n{{dependencies}}\n\nLeft only:\n{{dep.left}}",
    },
  ],
};

describe("custom workflow graphs", () => {
  it("executes ready nodes, injects declared outputs, and returns the output node", async () => {
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));
    const events: OrchestrationStreamEvent[] = [];

    const result = await orchestrator.run({
      mode: "custom",
      prompt: "Choose an architecture",
      participants,
      synthesizer: participants[1],
      workflow: graph,
      budget: { maxCalls: 3, maxRounds: 1 },
    }, {
      runId: "custom-test",
      emit: event => events.push(event),
    });

    expect(provider.calls).toHaveLength(3);
    expect(result.steps.map(step => step.id)).toEqual(["left", "right", "final"]);
    expect(result.steps[2]?.model.model).toBe("mock-claude");
    expect(result.steps[2]?.dependsOn).toEqual(["left", "right"]);
    expect(result.final).toBe(result.steps[2]?.content);

    const finalPrompt = provider.calls[2]?.messages.at(-1)?.content ?? "";
    expect(finalPrompt).toContain("Choose an architecture");
    expect(finalPrompt).toContain("[left]");
    expect(finalPrompt).toContain("[right]");
    expect(finalPrompt).not.toContain("{{dep.left}}");

    const started = events.find((event): event is Extract<OrchestrationStreamEvent, { type: "step_started" }> => (
      event.type === "step_started" && event.stepId === "final"
    ));
    expect(started?.dependsOn).toEqual(["left", "right"]);
  });

  it("rejects cycles before spending provider calls", async () => {
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));

    await expect(orchestrator.run({
      mode: "custom",
      prompt: "Do not run",
      participants,
      workflow: {
        name: "Cycle",
        outputNodeId: "a",
        nodes: [
          { id: "a", kind: "answer", model: { type: "participant", index: 0 }, dependsOn: ["b"], promptTemplate: "A" },
          { id: "b", kind: "answer", model: { type: "participant", index: 1 }, dependsOn: ["a"], promptTemplate: "B" },
        ],
      },
    })).rejects.toThrow(/cycle/i);

    expect(provider.calls).toHaveLength(0);
  });

  it("rejects undeclared dependency placeholders", async () => {
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));

    await expect(orchestrator.run({
      mode: "custom",
      prompt: "Do not run",
      participants,
      workflow: {
        name: "Hidden dependency",
        outputNodeId: "b",
        nodes: [
          { id: "a", kind: "answer", model: { type: "participant", index: 0 }, promptTemplate: "A" },
          { id: "b", kind: "synthesis", model: { type: "participant", index: 1 }, promptTemplate: "{{dep.a}}" },
        ],
      },
    })).rejects.toThrow(/without declaring/i);

    expect(provider.calls).toHaveLength(0);
  });

  it("enforces call budget from workflow node count before execution", async () => {
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));

    await expect(orchestrator.run({
      mode: "custom",
      prompt: "Do not run",
      participants,
      workflow: graph,
      budget: { maxCalls: 2, maxRounds: 1 },
    })).rejects.toThrow(/requires 3/i);

    expect(provider.calls).toHaveLength(0);
  });
});
