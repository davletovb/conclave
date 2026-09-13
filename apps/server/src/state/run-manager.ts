import type {
  OrchestrationRequest,
  OrchestrationStreamEvent,
  RunEventRecord,
  StartRunRequest,
  StartRunResponse,
  StoredRun,
} from "@conclave/core";
import { Orchestrator } from "../orchestrator.js";
import { FileStateStore } from "./file-store.js";

type RunListener = (record: RunEventRecord) => void;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown orchestration error";
}

export class RunManager {
  private readonly listeners = new Map<string, Set<RunListener>>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly nextSequence = new Map<string, number>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly activeConversations = new Set<string>();

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly store: FileStateStore,
  ) {}

  async init() {
    await this.store.init();
  }

  async start(input: StartRunRequest): Promise<StartRunResponse> {
    this.validate(input.request);
    const reservedConversationId = input.conversationId;
    if (reservedConversationId) this.reserveConversation(reservedConversationId);

    try {
      const created = await this.store.createRun(input.request, reservedConversationId);
      this.activeConversations.add(created.run.conversationId);
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

  async getRun(runId: string) {
    return this.store.getRun(runId);
  }

  async getConversation(conversationId: string) {
    return this.store.getConversation(conversationId);
  }

  async listConversations() {
    return this.store.listConversations();
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

  private reserveConversation(conversationId: string) {
    if (this.activeConversations.has(conversationId)) {
      throw new Error("This conversation already has an active run. Wait for it to finish or start a new conversation.");
    }
    this.activeConversations.add(conversationId);
  }

  private launch(run: StoredRun, history: OrchestrationRequest["history"]) {
    if (this.active.has(run.id)) return;
    const task = this.execute(run, history ?? [])
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(run.id);
        this.activeConversations.delete(run.conversationId);
      });
    this.active.set(run.id, task);
  }

  private async execute(run: StoredRun, history: NonNullable<OrchestrationRequest["history"]>) {
    await this.store.updateRun(run.id, { status: "running", error: undefined });
    const request: OrchestrationRequest = { ...run.request, history };

    try {
      const result = await this.orchestrator.run(request, {
        runId: run.id,
        emit: event => this.record(run.id, run.attempt, event),
      });
      await this.flush(run.id);
      await this.store.completeRun(run.id, result);
    } catch (error) {
      await this.flush(run.id);
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
        for (const listener of this.listeners.get(runId) ?? []) {
          listener(record);
        }
      });
    this.eventQueues.set(runId, next);
  }

  private async flush(runId: string) {
    await this.eventQueues.get(runId)?.catch(() => undefined);
  }

  private validate(request: OrchestrationRequest) {
    if (!request.prompt?.trim()) throw new Error("Prompt is required");
    if (!Array.isArray(request.participants) || request.participants.length === 0) {
      throw new Error("At least one participant is required");
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
