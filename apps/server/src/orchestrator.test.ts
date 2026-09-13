import { describe, expect, it } from "vitest";
import type {
  ModelRef,
  OrchestrationStreamEvent,
  ProviderEventSink,
  ProviderRequest,
} from "@conclave/core";
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

class StreamingMockProvider extends MockProvider {
  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {
    emit?.({ type: "text_delta", delta: "streamed " });
    emit?.({ type: "text_delta", delta: "answer" });
    const response = await super.generate(request);
    return { ...response, content: "streamed answer" };
  }
}

class UsageMockProvider extends MockProvider {
  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {
    emit?.({ type: "usage", inputTokens: 10, outputTokens: 2 });
    emit?.({ type: "usage", inputTokens: 10, outputTokens: 5 });
    return super.generate(request);
  }
}

class RateLimitedProvider extends MockProvider {
  override async generate(request: ProviderRequest) {
    if (request.model) throw new Error("Rate limit exceeded; try again later");
    return super.generate(request);
  }
}

class AbortAwareProvider extends MockProvider {
  override async generate(request: ProviderRequest) {
    return new Promise<never>((_resolve, reject) => {
      const fail = () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      };
      if (request.signal?.aborted) return fail();
      request.signal?.addEventListener("abort", fail, { once: true });
    });
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

  it("uses the budget round limit for debate", async () => {
    const countingProvider = new CountingMockProvider();
    const countingOrchestrator = new Orchestrator(new Map([[countingProvider.id, countingProvider]]));
    const result = await countingOrchestrator.run({
      mode: "debate",
      prompt: "Debate once",
      participants,
      maxRounds: 3,
      budget: { maxCalls: 20, maxRounds: 1 },
    });

    expect(result.steps.filter(step => step.kind === "critique")).toHaveLength(3);
    expect(countingProvider.calls).toBe(7);
  });

  it("rejects an insufficient call budget before spending any provider calls", async () => {
    const countingProvider = new CountingMockProvider();
    const countingOrchestrator = new Orchestrator(new Map([[countingProvider.id, countingProvider]]));

    await expect(countingOrchestrator.run({
      mode: "panel",
      prompt: "Do not start",
      participants,
      budget: { maxCalls: 3, maxRounds: 1 },
    })).rejects.toThrow(/requires 4/i);
    expect(countingProvider.calls).toBe(0);
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

  it("builds and audits consensus instead of treating synthesis as automatic agreement", async () => {
    const countingProvider = new CountingMockProvider();
    const countingOrchestrator = new Orchestrator(new Map([[countingProvider.id, countingProvider]]));
    const result = await countingOrchestrator.run({
      mode: "consensus",
      prompt: "Choose the safest migration strategy",
      participants,
    });

    expect(countingProvider.calls).toBe(5);
    expect(result.steps.map(step => step.kind)).toEqual([
      "answer",
      "answer",
      "answer",
      "synthesis",
      "review",
    ]);
    expect(result.final).toBe(result.steps.at(-1)?.content);
  });

  it("judges independent candidates with one bounded adjudication call", async () => {
    const countingProvider = new CountingMockProvider();
    const countingOrchestrator = new Orchestrator(new Map([[countingProvider.id, countingProvider]]));
    const result = await countingOrchestrator.run({
      mode: "judge",
      prompt: "Which design is strongest?",
      participants,
    });

    expect(countingProvider.calls).toBe(4);
    expect(result.steps.at(-1)?.kind).toBe("judgment");
  });

  it("red-teams one draft and returns a hardened revision", async () => {
    const countingProvider = new CountingMockProvider();
    const countingOrchestrator = new Orchestrator(new Map([[countingProvider.id, countingProvider]]));
    const result = await countingOrchestrator.run({
      mode: "red-team",
      prompt: "Propose a rollout plan",
      participants,
    });

    expect(countingProvider.calls).toBe(4);
    expect(result.steps.map(step => step.kind)).toEqual(["answer", "critique", "critique", "revision"]);
  });

  it("routes to one specialist instead of fanning the question out", async () => {
    const countingProvider = new CountingMockProvider();
    const countingOrchestrator = new Orchestrator(new Map([[countingProvider.id, countingProvider]]));
    const result = await countingOrchestrator.run({
      mode: "router",
      prompt: "Who should solve this?",
      participants,
    });

    expect(countingProvider.calls).toBe(2);
    expect(result.steps.map(step => step.kind)).toEqual(["route", "answer"]);
    expect(result.steps[1]?.model.model).toBe("mock-claude");
  });

  it("uses exactly one research-council member per selected model before synthesis", async () => {
    const countingProvider = new CountingMockProvider();
    const countingOrchestrator = new Orchestrator(new Map([[countingProvider.id, countingProvider]]));
    const result = await countingOrchestrator.run({
      mode: "research-council",
      prompt: "Assess the evidence",
      participants,
      budget: { maxCalls: 4, maxRounds: 1 },
    });

    const research = result.steps.filter(step => step.kind === "research");
    expect(countingProvider.calls).toBe(4);
    expect(research).toHaveLength(3);
    expect(research.map(step => step.model.model)).toEqual(participants.map(model => model.model));
    expect(result.steps.at(-1)?.kind).toBe("synthesis");
  });

  it("runs planner, executors, then reviewer with bounded stages", async () => {
    const countingProvider = new CountingMockProvider();
    const countingOrchestrator = new Orchestrator(new Map([[countingProvider.id, countingProvider]]));
    const result = await countingOrchestrator.run({
      mode: "planner-executor",
      prompt: "Design an implementation",
      participants,
    });

    expect(countingProvider.calls).toBe(4);
    expect(result.steps.map(step => step.kind)).toEqual(["plan", "execution", "execution", "review"]);
    expect(result.final).toBe(result.steps.at(-1)?.content);
  });

  it("emits normalized run usage including provider token reports", async () => {
    const usageProvider = new UsageMockProvider();
    const usageOrchestrator = new Orchestrator(new Map([[usageProvider.id, usageProvider]]));
    const events: OrchestrationStreamEvent[] = [];

    await usageOrchestrator.run({
      mode: "single",
      prompt: "Count usage",
      participants: [participants[0]],
      budget: { maxCalls: 1, maxRounds: 1 },
    }, {
      runId: "usage-test",
      emit: event => events.push(event),
    });

    const usageEvents = events.filter((event): event is Extract<OrchestrationStreamEvent, { type: "run_usage" }> => event.type === "run_usage");
    expect(usageEvents.at(-1)?.usage).toMatchObject({
      callsStarted: 1,
      callsCompleted: 1,
      inputTokens: 10,
      outputTokens: 5,
      tokenReports: 2,
    });
  });

  it("normalizes provider rate-limit failures", async () => {
    const limited = new RateLimitedProvider();
    const limitedOrchestrator = new Orchestrator(new Map([[limited.id, limited]]));
    const events: OrchestrationStreamEvent[] = [];

    await expect(limitedOrchestrator.run({
      mode: "single",
      prompt: "Hit limit",
      participants: [participants[0]],
    }, {
      runId: "limit-test",
      emit: event => events.push(event),
    })).rejects.toThrow(/rate limit/i);

    const notice = events.find((event): event is Extract<OrchestrationStreamEvent, { type: "rate_limit" }> => event.type === "rate_limit");
    expect(notice?.notice).toMatchObject({ provider: "mock", model: "mock-gpt", stepId: "answer-1" });
  });

  it("propagates run cancellation into the active provider call", async () => {
    const abortProvider = new AbortAwareProvider();
    const abortOrchestrator = new Orchestrator(new Map([[abortProvider.id, abortProvider]]));
    const controller = new AbortController();
    const events: OrchestrationStreamEvent[] = [];
    const promise = abortOrchestrator.run({
      mode: "single",
      prompt: "Cancel this",
      participants: [participants[0]],
    }, {
      runId: "cancel-test",
      signal: controller.signal,
      emit: event => events.push(event),
    });

    controller.abort();
    await expect(promise).rejects.toThrow(/cancel/i);
    expect(events.some(event => event.type === "run_cancelled")).toBe(true);
  });

  it("emits a complete normalized lifecycle for non-streaming providers", async () => {
    const events: OrchestrationStreamEvent[] = [];
    await orchestrator.run({
      mode: "single",
      prompt: "Answer once",
      participants: [participants[0]],
    }, {
      runId: "run-test",
      emit: event => events.push(event),
    });

    expect(events.map(event => event.type)).toEqual([
      "run_started",
      "run_usage",
      "run_usage",
      "step_started",
      "run_usage",
      "text_delta",
      "step_completed",
      "run_completed",
    ]);
    expect(events.every(event => event.runId === "run-test")).toBe(true);
  });

  it("forwards provider deltas without appending a duplicate fallback delta", async () => {
    const streamingProvider = new StreamingMockProvider();
    const streamingOrchestrator = new Orchestrator(new Map([[streamingProvider.id, streamingProvider]]));
    const events: OrchestrationStreamEvent[] = [];

    const result = await streamingOrchestrator.run({
      mode: "single",
      prompt: "Stream this",
      participants: [participants[0]],
    }, {
      runId: "stream-test",
      emit: event => events.push(event),
    });

    const deltas = events.filter((event): event is Extract<OrchestrationStreamEvent, { type: "text_delta" }> => event.type === "text_delta");
    expect(deltas.map(event => event.delta)).toEqual(["streamed ", "answer"]);
    expect(result.final).toBe("streamed answer");
  });
});
