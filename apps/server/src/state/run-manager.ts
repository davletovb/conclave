import type {
  OrchestrationRequest,
  OrchestrationStreamEvent,
  RunEventRecord,
  StartRunRequest,
  StartRunResponse,
  StoredRun,
} from "@conclave/core";
import { Orchestrator } from "../orchestrator.js";
import { FileStateStore, type ListOptions } from "./file-store.js";
import { inspectRun } from "./run-inspection.js";

type RunListener = (record: RunEventRecord) => void;

const DEFAULT_MAX_CALLS = 12;
const ABSOLUTE_MAX_CALLS = 64;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown orchestration error";
}

function isTerminal(status: StoredRun["status"]) {
  return ["completed", "failed", "interrupted", "cancelled"].includes(status);
}

export class RunManager {
  private readonly listeners = new Map<string, Set<RunListener>>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly nextSequence = new Map<string, number>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly activeControllers = new Map<string, AbortController>();
  /** Which conversations are claimed, and by what, so the guard can say so. */
  private readonly activeConversations = new Map<string, "run" | "delete">();
  /** Which active run owns a conversation reservation. */
  private readonly activeRunByConversation = new Map<string, string>();

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly store: FileStateStore,
  ) {}

  async init() {
    await this.store.init();
  }

  async start(input: StartRunRequest): Promise<StartRunResponse> {
    const request = this.normalizeRequest(input.request);
    this.validate(request);
    this.orchestrator.validateRequest(request);
    const reservedConversationId = input.conversationId;
    if (reservedConversationId) this.reserveConversation(reservedConversationId);

    try {
      const created = await this.store.createRun(request, reservedConversationId);
      this.activeConversations.set(created.run.conversationId, "run");
      this.nextSequence.set(created.run.id, 0);
      this.launch(created.run, created.history);
      return this.response(created.run);
    } catch (error) {
      if (reservedConversationId) this.activeConversations.delete(reservedConversationId);
      throw error;
    }
  }

  async resume(runId: string): Promise<StartRunResponse> {
    const existing = await this.store.getRun(runId);
    if (!existing) throw new Error(`Run ${runId} was not found`);
    const request = this.normalizeRequest(existing.request);
    this.validate(request);
    this.orchestrator.validateRequest(request);
    this.reserveConversation(existing.conversationId);

    try {
      const run = await this.store.prepareResume(runId);
      const history = await this.store.historyForRun(runId);
      this.nextSequence.set(run.id, 0);
      this.launch(run, history);
      return this.response(run);
    } catch (error) {
      this.activeConversations.delete(existing.conversationId);
      throw error;
    }
  }

  async cancel(runId: string) {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run ${runId} was not found`);
    if (isTerminal(run.status)) return run;

    // Completion wins a race with cancellation once its terminal event is
    // durable, even if state.json has not yet caught up.
    await this.flush(runId);
    const records = await this.store.readRunEvents(runId);
    const durableCompletion = [...records]
      .reverse()
      .find(record => record.attempt === run.attempt && record.event.type === "run_completed");
    if (durableCompletion?.event.type === "run_completed") {
      return this.store.completeRun(runId, durableCompletion.event.result);
    }

    const requestedAt = new Date().toISOString();
    const updated = await this.store.updateRun(runId, {
      status: "cancelling",
      cancelRequestedAt: requestedAt,
      error: "Cancellation requested. Stopping the active provider call…",
    });

    const controller = this.activeControllers.get(runId);
    if (controller) {
      controller.abort();
      return updated;
    }

    // Defensive path for a queued run that has not acquired its controller.
    this.record(run.id, run.attempt, {
      type: "run_cancelled",
      runId: run.id,
      message: "Run cancelled by user",
    });
    await this.flush(run.id);
    return this.store.updateRun(run.id, {
      status: "cancelled",
      error: "Run cancelled by user",
    });
  }

  async getRun(runId: string) {
    return this.store.getRun(runId);
  }

  async inspect(runId: string) {
    await this.flush(runId);
    const run = await this.store.getRun(runId);
    if (!run) return null;
    return inspectRun(this.store, run);
  }

  async getConversation(conversationId: string) {
    return this.store.getConversation(conversationId);
  }

  async listConversations(options: ListOptions = {}) {
    return this.store.listConversations(options);
  }

  async renameConversation(conversationId: string, title: string) {
    return this.store.renameConversation(conversationId, title);
  }

  async deleteConversation(conversationId: string) {
    // Claim delete synchronously before the first await so start() cannot slip
    // between a terminal run releasing its reservation and the store deletion.
    // If the holder is a genuinely live run, restore its reservation and reject.
    const existing = this.activeConversations.get(conversationId);
    if (existing === "delete") {
      throw new Error("This conversation is being deleted.");
    }

    if (existing === "run") {
      const runId = this.activeRunByConversation.get(conversationId);
      if (!runId) {
        throw new Error("This conversation already has an active run. Wait for it to finish or start a new conversation.");
      }

      this.activeConversations.set(conversationId, "delete");
      const run = await this.store.getRun(runId);
      if (run && isTerminal(run.status)) {
        // The terminal status can be visible before execute() finishes its last
        // writes. Keep the delete claim while that exact task settles.
        await this.active.get(runId)?.catch(() => undefined);
      } else if (this.activeRunByConversation.get(conversationId) === runId) {
        // Still genuinely live: give the reservation back to the run and keep
        // the longstanding guard behavior.
        this.activeConversations.set(conversationId, "run");
        throw new Error("This conversation already has an active run. Wait for it to finish or start a new conversation.");
      }
      // If the task finished while getRun() was in flight, its finally already
      // removed the run owner. The delete claim remains ours, so it is safe to
      // continue without reopening a start/delete gap.
    } else {
      this.activeConversations.set(conversationId, "delete");
    }

    try {
      await this.store.deleteConversation(conversationId);
    } finally {
      if (this.activeConversations.get(conversationId) === "delete") {
        this.activeConversations.delete(conversationId);
      }
    }
    return { id: conversationId, deleted: true as const };
  }

  async exportConversation(conversationId: string) {
    return this.store.exportConversation(conversationId);
  }

  async events(runId: string, after = 0) {
    return this.store.readRunEvents(runId, after);
  }

  subscribe(runId: string, listener: RunListener) {
    const listeners = this.listeners.get(runId) ?? new Set<RunListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(runId);
    };
  }

  /**
   * Claims a conversation for one exclusive operation. The check and the claim
   * are synchronous on purpose: nothing may await between them, or two callers
   * can both believe the conversation is free.
   */
  private reserveConversation(conversationId: string, holder: "run" | "delete" = "run") {
    const existing = this.activeConversations.get(conversationId);
    if (existing === "run") {
      throw new Error("This conversation already has an active run. Wait for it to finish or start a new conversation.");
    }
    if (existing === "delete") {
      throw new Error("This conversation is being deleted.");
    }
    this.activeConversations.set(conversationId, holder);
  }

  private launch(run: StoredRun, history: OrchestrationRequest["history"]) {
    if (this.active.has(run.id)) return;
    const controller = new AbortController();
    this.activeControllers.set(run.id, controller);
    this.activeRunByConversation.set(run.conversationId, run.id);
    const task = this.execute(run, history ?? [], controller.signal)
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(run.id);
        this.activeControllers.delete(run.id);
        if (this.activeRunByConversation.get(run.conversationId) === run.id) {
          this.activeRunByConversation.delete(run.conversationId);
          if (this.activeConversations.get(run.conversationId) === "run") {
            this.activeConversations.delete(run.conversationId);
          }
        }
      });
    this.active.set(run.id, task);
  }

  private async execute(
    run: StoredRun,
    history: NonNullable<OrchestrationRequest["history"]>,
    signal: AbortSignal,
  ) {
    if (signal.aborted) {
      await this.store.updateRun(run.id, { status: "cancelled", error: "Run cancelled by user" });
      return;
    }

    await this.store.updateRun(run.id, { status: "running", error: undefined });
    const request: OrchestrationRequest = { ...this.normalizeRequest(run.request), history };

    try {
      const result = await this.orchestrator.run(request, {
        runId: run.id,
        signal,
        emit: event => this.record(run.id, run.attempt, event),
      });
      await this.flush(run.id);

      if (signal.aborted) {
        const records = await this.store.readRunEvents(run.id);
        const hasCancellation = records.some(record => record.attempt === run.attempt && record.event.type === "run_cancelled");
        if (!hasCancellation) {
          this.record(run.id, run.attempt, {
            type: "run_cancelled",
            runId: run.id,
            message: "Run cancelled by user",
          });
          await this.flush(run.id);
        }
        await this.store.updateRun(run.id, { status: "cancelled", error: "Run cancelled by user" });
        return;
      }

      await this.store.completeRun(run.id, result);
    } catch (error) {
      await this.flush(run.id);
      if (signal.aborted) {
        await this.store.updateRun(run.id, {
          status: "cancelled",
          error: "Run cancelled by user",
        });
        return;
      }
      await this.store.updateRun(run.id, {
        status: "failed",
        error: errorMessage(error),
      });
    }
  }

  private record(runId: string, attempt: number, event: OrchestrationStreamEvent) {
    const seq = (this.nextSequence.get(runId) ?? 0) + 1;
    this.nextSequence.set(runId, seq);
    const record: RunEventRecord = {
      seq,
      attempt,
      at: new Date().toISOString(),
      event,
    };

    const previous = this.eventQueues.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.store.appendRunEvent(record);
        if (event.type === "run_usage") {
          await this.store.updateRun(runId, { usage: event.usage });
        } else if (event.type === "rate_limit") {
          await this.store.updateRun(runId, { rateLimit: event.notice });
        } else if (event.type === "run_cancelled") {
          await this.store.updateRun(runId, { status: "cancelled", error: event.message });
        }
        for (const listener of this.listeners.get(runId) ?? []) {
          listener(record);
        }
      });
    this.eventQueues.set(runId, next);
  }

  private async flush(runId: string) {
    await this.eventQueues.get(runId)?.catch(() => undefined);
  }

  private normalizeRequest(request: OrchestrationRequest): OrchestrationRequest {
    const legacyRounds = request.maxRounds;
    return {
      ...request,
      budget: {
        maxCalls: request.budget?.maxCalls ?? DEFAULT_MAX_CALLS,
        maxRounds: request.budget?.maxRounds ?? legacyRounds ?? 1,
      },
    };
  }

  private validate(request: OrchestrationRequest) {
    if (!request.prompt?.trim()) throw new Error("Prompt is required");
    if (!Array.isArray(request.participants) || request.participants.length === 0) {
      throw new Error("At least one participant is required");
    }

    const maxCalls = request.budget?.maxCalls;
    if (!Number.isInteger(maxCalls) || (maxCalls ?? 0) < 1 || (maxCalls ?? 0) > ABSOLUTE_MAX_CALLS) {
      throw new Error(`maxCalls must be an integer between 1 and ${ABSOLUTE_MAX_CALLS}`);
    }
    const maxRounds = request.budget?.maxRounds;
    if (!Number.isInteger(maxRounds) || (maxRounds ?? 0) < 1 || (maxRounds ?? 0) > 3) {
      throw new Error("maxRounds must be an integer between 1 and 3");
    }
  }

  private response(run: StoredRun): StartRunResponse {
    return {
      conversationId: run.conversationId,
      runId: run.id,
      status: run.status,
      attempt: run.attempt,
    };
  }
}
