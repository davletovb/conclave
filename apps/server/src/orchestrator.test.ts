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
  calls = 0;

  override async generate(request: ProviderRequest) {
    this.calls += 1;
    if (request.model) throw new Error("Too many requests; try again later");
    return super.generate(request);
  }
}

class FlakyProvider extends MockProvider {
  attempts = new Map<string, number>();
  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {
    const count = (this.attempts.get(request.model) ?? 0) + 1;
    this.attempts.set(request.model, count);
    if (request.model === "mock-claude" && count === 1) throw new Error("temporary connection unavailable");
    return super.generate(request);
  }
}

class PartialFailureProvider extends MockProvider {
  calls: string[] = [];

  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {
    this.calls.push(request.model);
    if (request.model === "mock-claude" || request.model === "mock-finalizer") throw new Error("provider authentication unavailable");
    return super.generate(request);
  }
}

class AllAnswersFailProvider extends MockProvider {
  calls: string[] = [];

  override async generate(request: ProviderRequest) {
    this.calls.push(request.model);
    if (request.model !== "mock-finalizer") throw new Error("provider authentication unavailable");
    return super.generate(request);
  }
}

class DebateReclaimProvider extends MockProvider {
  roundOneGrokAttempts = 0;

  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {
    const latest = request.messages.at(-1)?.content ?? "";
    if (
      request.model === "mock-claude" &&
      latest.startsWith("You are in debate round 1.")
    ) {
      throw new Error("provider authentication unavailable");
    }
    if (request.model === "mock-grok" && latest.startsWith("You are in debate round 1.")) {
      this.roundOneGrokAttempts += 1;
      if (this.roundOneGrokAttempts === 1) {
        throw new Error("temporary connection unavailable");
      }
    }
    return super.generate(request);
  }
}

class StallThenRecoverProvider extends MockProvider {
  calls = 0;
  aborted = 0;

  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {
    this.calls += 1;
    if (this.calls > 1) return super.generate(request);

    emit?.({ type: "text_delta", delta: "partial-before-stall" });
    return new Promise<never>((_resolve, reject) => {
      const abort = () => {
        this.aborted += 1;
        const error = new Error("stalled attempt aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (request.signal?.aborted) return abort();
      request.signal?.addEventListener("abort", abort, { once: true });
    });
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

  it("retries one transient failed step without restarting successful siblings", async () => {
    const flaky = new FlakyProvider();
    const instance = new Orchestrator(new Map([[flaky.id, flaky]]));
    const events: OrchestrationStreamEvent[] = [];
    const result = await instance.run({ mode: "panel", prompt: "Recover", participants, budget: { maxCalls: 6, maxRounds: 1 } }, { runId: "retry-step", emit: event => events.push(event) });
    expect(result.degraded).not.toBe(true);
    expect(flaky.attempts.get("mock-claude")).toBe(2);
    expect(events.some(event => event.type === "step_retrying" && event.stepId === "answer-2")).toBe(true);
  });

  it("reserves the required finalizer call instead of spending it on a retry", async () => {
    const flaky = new FlakyProvider();
    const instance = new Orchestrator(new Map([[flaky.id, flaky]]));
    const result = await instance.run({
      mode: "panel",
      prompt: "Protect the finalizer",
      participants,
      budget: { maxCalls: 4, maxRounds: 1 },
    });

    expect(flaky.attempts.get("mock-claude")).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.steps.at(-1)?.kind).toBe("synthesis");
  });

  it("chooses a consensus verifier only from successful candidate models", async () => {
    const partial = new PartialFailureProvider();
    const instance = new Orchestrator(new Map([[partial.id, partial]]));
    const result = await instance.run({
      mode: "consensus",
      prompt: "Use a surviving verifier",
      participants,
      budget: { maxCalls: 5, maxRounds: 1 },
    });

    expect(result.degraded).toBe(true);
    expect(partial.calls.filter(model => model === "mock-claude")).toHaveLength(1);
    expect(result.steps.at(-1)?.kind).toBe("review");
    expect(result.steps.at(-1)?.model.model).toBe("mock-grok");
  });

  it("narrows debate rounds to providers that survived the previous stage", async () => {
    const partial = new PartialFailureProvider();
    const instance = new Orchestrator(new Map([[partial.id, partial]]));
    const result = await instance.run({
      mode: "debate",
      prompt: "Drop failed debaters",
      participants,
      budget: { maxCalls: 10, maxRounds: 2 },
    });

    expect(result.degraded).toBe(true);
    expect(partial.calls.filter(model => model === "mock-claude")).toHaveLength(1);
    expect(result.steps.filter(step => step.kind === "critique")).toHaveLength(4);
    expect(result.steps.at(-1)?.kind).toBe("synthesis");
  });

  it("reclaims same-round debate dropouts before retry gating", async () => {
    const provider = new DebateReclaimProvider();
    const instance = new Orchestrator(new Map([[provider.id, provider]]));
    const result = await instance.run({
      mode: "debate",
      prompt: "Reclaim debate slots",
      participants,
      budget: { maxCalls: 10, maxRounds: 2 },
    });

    expect(provider.roundOneGrokAttempts).toBe(2);
    expect(result.steps.filter(step => step.kind === "answer")).toHaveLength(3);
    expect(result.steps.filter(step => step.kind === "critique")).toHaveLength(4);
    expect(result.degraded).toBe(true);
    expect(result.steps.at(-1)?.kind).toBe("synthesis");
  });

  it("does not invoke a finalizer when every independent answer fails", async () => {
    const failing = new AllAnswersFailProvider();
    const instance = new Orchestrator(new Map([[failing.id, failing]]));
    const finalizer: ModelRef = { provider: "mock", model: "mock-finalizer", label: "External Judge" };

    await expect(instance.run({
      mode: "judge",
      prompt: "No survivors",
      participants: [participants[0], participants[2]],
      synthesizer: finalizer,
      budget: { maxCalls: 3, maxRounds: 1 },
    })).rejects.toThrow(/all parallel model steps failed/i);
    expect(failing.calls).not.toContain("mock-finalizer");
  });

  it("keeps successful panel contributions when one provider fails permanently", async () => {
    const partial = new PartialFailureProvider();
    const instance = new Orchestrator(new Map([[partial.id, partial]]));
    const result = await instance.run({ mode: "panel", prompt: "Use survivors", participants, budget: { maxCalls: 6, maxRounds: 1 } });
    expect(result.degraded).toBe(true);
    expect(result.failures?.map(failure => failure.stepId)).toContain("answer-2");
    expect(result.steps.filter(step => step.kind === "answer")).toHaveLength(2);
    expect(result.steps.at(-1)?.kind).toBe("synthesis");
  });

  it("returns a degraded survivor result when an independent finalizer fails", async () => {
    const partial = new PartialFailureProvider();
    const instance = new Orchestrator(new Map([[partial.id, partial]]));
    const finalizer: ModelRef = { provider: "mock", model: "mock-finalizer", label: "External Judge" };
    const result = await instance.run({ mode: "judge", prompt: "Judge fairly", participants: [participants[0], participants[2]], synthesizer: finalizer, budget: { maxCalls: 5, maxRounds: 1 } });
    expect(result.degraded).toBe(true);
    expect(result.failures?.some(failure => failure.model.model === "mock-finalizer")).toBe(true);
    expect(result.final).toMatch(/preserves the surviving model work/i);
  });

  it("aborts a stalled provider attempt and retries only that step", async () => {
    const stalled = new StallThenRecoverProvider();
    const instance = new Orchestrator(
      new Map([[stalled.id, stalled]]),
      { stepStallTimeoutMs: 30 },
    );
    const events: OrchestrationStreamEvent[] = [];

    const result = await instance.run({
      mode: "single",
      prompt: "Recover from a stalled runtime",
      participants: [participants[0]],
      budget: { maxCalls: 2, maxRounds: 1 },
    }, {
      runId: "stall-retry-test",
      emit: event => events.push(event),
    });

    expect(stalled.calls).toBe(2);
    expect(stalled.aborted).toBe(1);
    expect(events.filter(event => event.type === "step_retrying")).toHaveLength(1);
    expect(events.find(event => event.type === "step_retrying")?.message).toMatch(/stalled/i);
    expect(result.final).toContain("Recover from a stalled runtime");
  });

  it("normalizes provider rate-limit failures", async () => {
    const limited = new RateLimitedProvider();
    const limitedOrchestrator = new Orchestrator(new Map([[limited.id, limited]]));
    const events: OrchestrationStreamEvent[] = [];

    await expect(limitedOrchestrator.run({
      mode: "single",
      prompt: "Hit limit",
      participants: [participants[0]],
      budget: { maxCalls: 2, maxRounds: 1 },
    }, {
      runId: "limit-test",
      emit: event => events.push(event),
    })).rejects.toThrow(/too many requests/i);

    const notice = events.find((event): event is Extract<OrchestrationStreamEvent, { type: "rate_limit" }> => event.type === "rate_limit");
    expect(notice?.notice).toMatchObject({ provider: "mock", model: "mock-gpt", stepId: "answer-1" });
    expect(limited.calls).toBe(1);
    expect(events.some(event => event.type === "step_retrying")).toBe(false);
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
