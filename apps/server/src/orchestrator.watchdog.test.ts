import { describe, expect, it } from "vitest";
import type {
  ModelRef,
  OrchestrationStreamEvent,
  ProviderEventSink,
  ProviderRequest,
  ProviderResponse,
} from "@conclave/core";
import { Orchestrator } from "./orchestrator.js";
import { MockProvider } from "./providers/mock.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const singleParticipant: ModelRef = {
  provider: "mock",
  model: "mock-gpt",
  label: "GPT (mock)",
};

class SyncThrowProvider extends MockProvider {
  capturedSignal?: AbortSignal;

  override generate(request: ProviderRequest): never {
    this.capturedSignal = request.signal;
    throw new Error("synchronous validation failure");
  }
}

class CancellationProvider extends MockProvider {
  override async generate(request: ProviderRequest): Promise<ProviderResponse> {
    return new Promise<ProviderResponse>((_resolve, reject) => {
      const abort = () => {
        const error = new Error("provider aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (request.signal?.aborted) {
        abort();
        return;
      }
      request.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class ParallelStallProvider extends MockProvider {
  readonly calls = new Map<string, number>();
  readonly aborted = new Map<string, number>();
  readonly signals = new Map<string, AbortSignal[]>();

  override async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const call = (this.calls.get(request.model) ?? 0) + 1;
    this.calls.set(request.model, call);
    if (request.signal) {
      const signals = this.signals.get(request.model) ?? [];
      signals.push(request.signal);
      this.signals.set(request.model, signals);
    }

    if (request.model === "mock-claude" && call === 1) {
      return new Promise<ProviderResponse>((_resolve, reject) => {
        const abort = () => {
          this.aborted.set(
            request.model,
            (this.aborted.get(request.model) ?? 0) + 1,
          );
          const error = new Error("stalled attempt aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (request.signal?.aborted) {
          abort();
          return;
        }
        request.signal?.addEventListener("abort", abort, { once: true });
      });
    }

    return {
      provider: this.id,
      model: request.model,
      latencyMs: 0,
      content: `ok:${request.model}`,
    };
  }
}

/** Reasons for a while before it answers: nothing to show, only activity, every few milliseconds. */
class ReasoningProvider extends MockProvider {
  constructor(private readonly reasoningMs: number, private readonly activityEveryMs: number | undefined) { super(); }

  override async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    const until = Date.now() + this.reasoningMs;
    while (Date.now() < until) {
      if (request.signal?.aborted) throw Object.assign(new Error("reasoning aborted"), { name: "AbortError" });
      await sleep(this.activityEveryMs ?? 5);
      if (this.activityEveryMs !== undefined) emit?.({ type: "activity" });
    }
    if (request.signal?.aborted) throw Object.assign(new Error("reasoning aborted"), { name: "AbortError" });
    return { provider: this.id, model: request.model, content: "considered answer", latencyMs: this.reasoningMs };
  }
}

describe("Orchestrator stall watchdog lifecycle", () => {
  it("counts a provider's activity as progress while it reasons, without recording it", async () => {
    // Reasons for three times the stall limit, reporting activity as it goes, as Seatline does for a model that thinks before it answers.
    const provider = new ReasoningProvider(90, 10);
    const instance = new Orchestrator(new Map([[provider.id, provider]]), { stepStallTimeoutMs: 30 });
    const events: OrchestrationStreamEvent[] = [];
    const result = await instance.run(
      { mode: "single", prompt: "think hard", participants: [singleParticipant] },
      { runId: "reasoning", emit: (event) => events.push(event) },
    );
    expect(result.final).toBe("considered answer");
    expect(events.some((event) => event.type === "step_retrying")).toBe(false);
    // Activity only keeps the step alive: none of it reaches the run's event log.
    expect(events.some((event) => (event as { type: string }).type === "activity")).toBe(false);
  });

  it("waits as long as an adapter says its runtime waits before calling a silent step stalled", async () => {
    // Silent for longer than the orchestrator's default, but within the adapter's own limit (Seatline's idle limit, say).
    const provider = Object.assign(new ReasoningProvider(60, undefined), { stallTimeoutMs: 500 });
    const instance = new Orchestrator(new Map([[provider.id, provider]]), { stepStallTimeoutMs: 20 });
    const events: OrchestrationStreamEvent[] = [];
    const result = await instance.run(
      { mode: "single", prompt: "think silently", participants: [singleParticipant] },
      { runId: "adapter-limit", emit: (event) => events.push(event) },
    );
    expect(result.final).toBe("considered answer");
    expect(events.some((event) => event.type === "step_retrying")).toBe(false);
  });

  it("cleans up the watchdog when a provider throws synchronously", async () => {
    const provider = new SyncThrowProvider();
    const instance = new Orchestrator(new Map([[provider.id, provider]]), {
      stepStallTimeoutMs: 20,
    });

    await expect(
      instance.run({
        mode: "single",
        prompt: "fail before returning a promise",
        participants: [singleParticipant],
      }),
    ).rejects.toThrow(/synchronous validation failure/i);

    expect(provider.capturedSignal).toBeDefined();
    await sleep(35);
    expect(provider.capturedSignal?.aborted).toBe(false);
  });

  it("lets parent cancellation win over the inactivity watchdog", async () => {
    const provider = new CancellationProvider();
    const instance = new Orchestrator(new Map([[provider.id, provider]]), {
      stepStallTimeoutMs: 100,
    });
    const controller = new AbortController();
    const events: OrchestrationStreamEvent[] = [];

    const run = instance.run(
      {
        mode: "single",
        prompt: "cancel this run",
        participants: [singleParticipant],
        budget: { maxCalls: 2, maxRounds: 1 },
      },
      {
        runId: "cancel-before-stall",
        signal: controller.signal,
        emit: (event) => events.push(event),
      },
    );

    setTimeout(() => controller.abort(), 20);

    let caught: unknown;
    try {
      await run;
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ name: "AbortError" });
    expect(caught instanceof Error ? caught.message : String(caught)).toMatch(
      /cancelled by user/i,
    );
    expect(events.some((event) => event.type === "run_cancelled")).toBe(true);
    expect(events.some((event) => event.type === "step_retrying")).toBe(false);
    expect(
      events.some(
        (event) =>
          "message" in event &&
          typeof event.message === "string" &&
          /stalled/i.test(event.message),
      ),
    ).toBe(false);
  });

  it("aborts and retries only the stalled sibling in a parallel run", async () => {
    const provider = new ParallelStallProvider();
    const instance = new Orchestrator(new Map([[provider.id, provider]]), {
      stepStallTimeoutMs: 20,
    });
    const events: OrchestrationStreamEvent[] = [];
    const participants: ModelRef[] = [
      { provider: "mock", model: "mock-gpt", label: "GPT (mock)" },
      { provider: "mock", model: "mock-claude", label: "Claude (mock)" },
    ];

    const result = await instance.run(
      {
        mode: "compare",
        prompt: "keep the healthy sibling alive",
        participants,
        budget: { maxCalls: 3, maxRounds: 1 },
      },
      {
        runId: "parallel-stall-isolation",
        emit: (event) => events.push(event),
      },
    );

    expect(result.degraded).not.toBe(true);
    expect(provider.calls.get("mock-gpt")).toBe(1);
    expect(provider.calls.get("mock-claude")).toBe(2);
    expect(provider.aborted.get("mock-claude")).toBe(1);
    expect(provider.signals.get("mock-gpt")?.[0]?.aborted).toBe(false);
    expect(events.filter((event) => event.type === "step_retrying")).toHaveLength(1);
    expect(events.some((event) => event.type === "run_cancelled")).toBe(false);
    expect(result.final).toContain("ok:mock-gpt");
    expect(result.final).toContain("ok:mock-claude");
  });
});
