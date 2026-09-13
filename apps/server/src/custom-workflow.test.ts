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

class SchedulingProvider extends MockProvider {
  started: string[] = [];
  slowReleased = false;
  private releaseSlow!: () => void;
  private readonly slowGate = new Promise<void>(resolve => { this.releaseSlow = resolve; });

  release() {
    this.slowReleased = true;
    this.releaseSlow();
  }

  override async generate(request: ProviderRequest) {
    const prompt = request.messages.at(-1)?.content ?? "";
    this.started.push(prompt);
    if (prompt === "slow-root") await this.slowGate;
    return super.generate(request);
  }
}

class FailingWorkflowProvider extends MockProvider {
  siblingAborted = false;

  override async generate(request: ProviderRequest) {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt === "slow-sibling") {
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          this.siblingAborted = true;
          const error = new Error("slow sibling aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (request.signal?.aborted) return abort();
        request.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (prompt === "failing-branch") throw new Error("branch exploded");
    return super.generate(request);
  }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
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

  it("does not recursively expand placeholder-like text inserted from the user prompt", async () => {
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));

    await orchestrator.run({
      mode: "custom",
      prompt: "Explain {{dependencies}} and {{dep.other}} literally",
      participants: [participants[0]],
      workflow: {
        name: "Literal placeholders",
        outputNodeId: "only",
        nodes: [
          { id: "only", kind: "answer", model: { type: "participant", index: 0 }, promptTemplate: "{{prompt}}" },
        ],
      },
    });

    expect(provider.calls[0]?.messages.at(-1)?.content).toBe("Explain {{dependencies}} and {{dep.other}} literally");
  });

  it("starts a dependent as soon as its own prerequisite finishes", async () => {
    const provider = new SchedulingProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));
    const run = orchestrator.run({
      mode: "custom",
      prompt: "schedule",
      participants,
      workflow: {
        name: "Independent branches",
        outputNodeId: "final",
        nodes: [
          { id: "slow", kind: "answer", model: { type: "participant", index: 0 }, promptTemplate: "slow-root" },
          { id: "fast", kind: "answer", model: { type: "participant", index: 1 }, promptTemplate: "fast-root" },
          { id: "next", kind: "research", model: { type: "participant", index: 1 }, dependsOn: ["fast"], promptTemplate: "after-fast" },
          { id: "final", kind: "synthesis", model: { type: "participant", index: 0 }, dependsOn: ["slow", "next"], promptTemplate: "final" },
        ],
      },
      budget: { maxCalls: 4, maxRounds: 1 },
    });

    await waitFor(() => provider.started.includes("after-fast"));
    expect(provider.slowReleased).toBe(false);
    provider.release();
    await run;
    expect(provider.started.indexOf("after-fast")).toBeLessThan(provider.started.indexOf("final"));
  });

  it("aborts and settles sibling work when one workflow branch fails", async () => {
    const provider = new FailingWorkflowProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));
    const events: OrchestrationStreamEvent[] = [];

    await expect(orchestrator.run({
      mode: "custom",
      prompt: "fail cleanly",
      participants,
      workflow: {
        name: "Failing branches",
        outputNodeId: "final",
        nodes: [
          { id: "slow", kind: "answer", model: { type: "participant", index: 0 }, promptTemplate: "slow-sibling" },
          { id: "bad", kind: "answer", model: { type: "participant", index: 1 }, promptTemplate: "failing-branch" },
          { id: "final", kind: "synthesis", model: { type: "participant", index: 0 }, dependsOn: ["slow", "bad"], promptTemplate: "final" },
        ],
      },
    }, {
      runId: "failing-workflow",
      emit: event => events.push(event),
    })).rejects.toThrow("branch exploded");

    expect(provider.siblingAborted).toBe(true);
    expect(events.some(event => event.type === "step_failed" && event.failure.stepId === "bad" && /branch exploded/.test(event.failure.message))).toBe(true);
    expect(events.some(event => event.type === "step_failed" && event.failure.stepId === "slow")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", runId: "failing-workflow", message: "branch exploded" });
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

  it("rejects malformed nodes before spending provider calls", async () => {
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));
    const malformed = {
      name: "Malformed",
      outputNodeId: "bad",
      nodes: [null],
    } as unknown as WorkflowGraph;

    await expect(orchestrator.run({
      mode: "custom",
      prompt: "Do not run",
      participants,
      workflow: malformed,
    })).rejects.toThrow(/node must be an object/i);
    expect(provider.calls).toHaveLength(0);

    const nonStringTemplate = {
      name: "Bad template",
      outputNodeId: "bad",
      nodes: [{ id: "bad", kind: "answer", model: { type: "participant", index: 0 }, promptTemplate: 42 }],
    } as unknown as WorkflowGraph;
    await expect(orchestrator.run({
      mode: "custom",
      prompt: "Do not run",
      participants,
      workflow: nonStringTemplate,
    })).rejects.toThrow(/string prompt template/i);
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects unsupported node kinds before spending provider calls", async () => {
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));
    const invalid = {
      name: "Invalid kind",
      outputNodeId: "bad",
      nodes: [
        { id: "bad", kind: "arbitrary", model: { type: "participant", index: 0 }, promptTemplate: "No" },
      ],
    } as unknown as WorkflowGraph;

    await expect(orchestrator.run({
      mode: "custom",
      prompt: "Do not run",
      participants,
      workflow: invalid,
    })).rejects.toThrow(/unsupported kind/i);

    expect(provider.calls).toHaveLength(0);
  });

  it("rejects nodes that do not contribute to the output", async () => {
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));

    await expect(orchestrator.run({
      mode: "custom",
      prompt: "Do not run",
      participants,
      workflow: {
        name: "Unused node",
        outputNodeId: "used",
        nodes: [
          { id: "used", kind: "answer", model: { type: "participant", index: 0 }, promptTemplate: "Used" },
          { id: "leftover", kind: "answer", model: { type: "participant", index: 1 }, promptTemplate: "Leftover" },
        ],
      },
    })).rejects.toThrow(/not connected to output/i);

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
