import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatMessage,
  Conversation,
  ConversationExport,
  ConversationExportRun,
  ConversationSummary,
  OrchestrationRequest,
  OrchestrationResult,
  OrchestrationStep,
  RateLimitNotice,
  RunEventRecord,
  RunStatus,
  RunUsage,
  StoredRun,
} from "@conclave/core";
import { emptyRunUsage } from "@conclave/core";
import { conversationSnippet, matchesConversation, searchTerms } from "./conversation-search.js";

type PersistedState = {
  version: 1;
  conversations: Record<string, Conversation>;
  runs: Record<string, StoredRun>;
};

type RunPatch = {
  status?: RunStatus;
  result?: OrchestrationResult;
  error?: string | undefined;
  attempt?: number;
  usage?: RunUsage;
  rateLimit?: RateLimitNotice | undefined;
  cancelRequestedAt?: string | undefined;
};

export type ListOptions = {
  query?: string;
  limit?: number;
};

export type CreatedRun = {
  run: StoredRun;
  conversation: Conversation;
  history: ChatMessage[];
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

function titleFromPrompt(prompt: string) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (!compact) return "New conversation";
  return compact.length > 64 ? `${compact.slice(0, 61)}…` : compact;
}

function cleanRequest(request: OrchestrationRequest): OrchestrationRequest {
  const { history: _history, ...rest } = request;
  return rest;
}

function laterTimestamp(a: string, b: string) {
  return a.localeCompare(b) >= 0 ? a : b;
}

export class FileStateStore {
  readonly dataDir: string;
  private readonly statePath: string;
  private readonly runsDir: string;
  private state: PersistedState = { version: 1, conversations: {}, runs: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;

  constructor(dataDir = process.env.CONCLAVE_DATA_DIR || join(homedir(), ".conclave")) {
    this.dataDir = dataDir;
    this.statePath = join(dataDir, "state.json");
    this.runsDir = join(dataDir, "runs");
  }

  async init() {
    if (this.initialized) return;
    await this.enqueue(async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await chmod(this.dataDir, 0o700);
      await mkdir(this.runsDir, { recursive: true, mode: 0o700 });
      await chmod(this.runsDir, 0o700);

      try {
        const raw = await readFile(this.statePath, "utf8");
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed.version !== 1) throw new Error(`Unsupported Conclave state version: ${parsed.version}`);
        this.state = parsed;
        await chmod(this.statePath, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.persistState();
      }

      await this.tightenEventPermissions();

      let changed = false;
      const timestamp = now();
      for (const run of Object.values(this.state.runs)) {
        if (!run.usage) {
          run.usage = emptyRunUsage();
          changed = true;
        }

        if (!["queued", "running", "cancelling"].includes(run.status)) continue;

        const records = await this.readRunEventFile(run.id);
        const terminal = [...records]
          .reverse()
          .find(record => record.attempt === run.attempt
            && (record.event.type === "run_completed"
              || record.event.type === "run_cancelled"
              || record.event.type === "error"));

        if (terminal?.event.type === "run_completed") {
          this.applyCompletion(run, terminal.event.result, terminal.at);
          changed = true;
          continue;
        }

        if (terminal?.event.type === "run_cancelled") {
          run.status = "cancelled";
          run.updatedAt = terminal.at;
          run.error = terminal.event.message;
          changed = true;
          continue;
        }

        if (terminal?.event.type === "error") {
          run.status = "failed";
          run.updatedAt = terminal.at;
          run.error = terminal.event.message;
          changed = true;
          continue;
        }

        run.status = "interrupted";
        run.updatedAt = timestamp;
        run.error = "Conclave stopped before this run completed. Resume it to start a new attempt.";
        changed = true;
      }
      if (changed) await this.persistState();
      this.initialized = true;
    });
  }

  async listConversations(options: ListOptions = {}): Promise<ConversationSummary[]> {
    await this.ready();
    const terms = searchTerms(options.query ?? "");
    const ordered = Object.values(this.state.conversations)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter(conversation => matchesConversation(conversation, terms))
      .map(conversation => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        lastRunId: conversation.lastRunId,
        messageCount: conversation.messages.length,
        snippet: conversationSnippet(conversation, terms),
      }));

    const limit = options.limit;
    return limit !== undefined && limit > 0 ? ordered.slice(0, limit) : ordered;
  }

  async renameConversation(id: string, title: string): Promise<Conversation> {
    await this.ready();
    return this.enqueue(async () => {
      const conversation = this.state.conversations[id];
      if (!conversation) throw new Error(`Conversation ${id} was not found`);
      const next = title.replace(/\s+/g, " ").trim();
      if (!next) throw new Error("A conversation title cannot be empty");
      conversation.title = next.length > 120 ? `${next.slice(0, 119)}…` : next;
      await this.persistState();
      return clone(conversation);
    });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.ready();
    await this.enqueue(async () => {
      const conversation = this.state.conversations[id];
      if (!conversation) throw new Error(`Conversation ${id} was not found`);
      const runIds = Object.values(this.state.runs)
        .filter(run => run.conversationId === id)
        .map(run => run.id);
      for (const runId of runIds) delete this.state.runs[runId];
      delete this.state.conversations[id];
      await this.persistState();

      // Event logs, including archived earlier attempts, are part of the
      // conversation's on-disk footprint and must go with it.
      const entries = await readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries
        .filter(entry => entry.isFile() && runIds.some(runId => entry.name.startsWith(`${runId}.`)))
        .map(entry => rm(join(this.runsDir, entry.name), { force: true })));
    });
  }

  async exportConversation(id: string): Promise<ConversationExport | null> {
    await this.ready();
    const conversation = this.state.conversations[id];
    if (!conversation) return null;

    const stored = Object.values(this.state.runs)
      .filter(run => run.conversationId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const runs: ConversationExportRun[] = [];
    for (const run of stored) {
      runs.push({
        id: run.id,
        attempt: run.attempt,
        status: run.status,
        mode: run.request.mode,
        participants: run.request.participants,
        synthesizer: run.request.synthesizer,
        workflow: run.request.workflow,
        usage: run.usage ?? emptyRunUsage(),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        // A failed or cancelled run has no result, but the work its models did
        // finish is in the event log. An export keeps the evidence, so recover
        // it rather than exporting metadata alone.
        steps: run.result?.steps ?? await this.completedStepsFromEvents(run.id, run.attempt),
        error: run.error,
      });
    }

    return clone({
      version: 1 as const,
      exportedAt: now(),
      conversation,
      runs,
    });
  }

  private async completedStepsFromEvents(runId: string, attempt: number) {
    const records = await this.readRunEventFile(runId);
    const steps = new Map<string, OrchestrationStep>();
    for (const record of records) {
      if (record.attempt !== attempt) continue;
      if (record.event.type === "step_completed") steps.set(record.event.step.id, record.event.step);
      else if (record.event.type === "step_failed") steps.delete(record.event.failure.stepId);
    }
    return [...steps.values()];
  }

  async getConversation(id: string) {
    await this.ready();
    const conversation = this.state.conversations[id];
    return conversation ? clone(conversation) : null;
  }

  async getRun(id: string) {
    await this.ready();
    const run = this.state.runs[id];
    return run ? clone(run) : null;
  }

  async createRun(request: OrchestrationRequest, conversationId?: string): Promise<CreatedRun> {
    await this.ready();
    return this.enqueue(async () => {
      const timestamp = now();
      let conversation = conversationId ? this.state.conversations[conversationId] : undefined;
      if (conversationId && !conversation) {
        throw new Error(`Conversation ${conversationId} was not found`);
      }

      if (!conversation) {
        conversation = {
          id: randomUUID(),
          title: titleFromPrompt(request.prompt),
          createdAt: timestamp,
          updatedAt: timestamp,
          messages: [],
        };
        this.state.conversations[conversation.id] = conversation;
      }

      const history: ChatMessage[] = conversation.messages.map(message => ({
        role: message.role,
        content: message.content,
      }));
      const runId = randomUUID();
      const userMessageId = randomUUID();
      conversation.messages.push({
        id: userMessageId,
        role: "user",
        content: request.prompt,
        createdAt: timestamp,
        runId,
      });
      conversation.updatedAt = timestamp;
      conversation.lastRunId = runId;

      const run: StoredRun = {
        id: runId,
        conversationId: conversation.id,
        userMessageId,
        status: "queued",
        attempt: 1,
        attemptStartedAt: timestamp,
        request: cleanRequest(request),
        usage: emptyRunUsage(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.state.runs[run.id] = run;
      await this.persistState();
      await this.clearRunEvents(run.id);

      return {
        run: clone(run),
        conversation: clone(conversation),
        history,
      };
    });
  }

  async historyForRun(runId: string): Promise<ChatMessage[]> {
    await this.ready();
    const run = this.state.runs[runId];
    if (!run) throw new Error(`Run ${runId} was not found`);
    const conversation = this.state.conversations[run.conversationId];
    if (!conversation) throw new Error(`Conversation ${run.conversationId} was not found`);
    const index = conversation.messages.findIndex(message => message.id === run.userMessageId);
    const previous = index >= 0 ? conversation.messages.slice(0, index) : conversation.messages;
    return previous.map(message => ({ role: message.role, content: message.content }));
  }

  async updateRun(runId: string, patch: RunPatch) {
    await this.ready();
    return this.enqueue(async () => {
      const run = this.state.runs[runId];
      if (!run) throw new Error(`Run ${runId} was not found`);
      if (patch.status !== undefined) run.status = patch.status;
      if (patch.result !== undefined) run.result = patch.result;
      if (patch.usage !== undefined) run.usage = clone(patch.usage);
      if (Object.prototype.hasOwnProperty.call(patch, "error")) {
        if (patch.error === undefined) delete run.error;
        else run.error = patch.error;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "rateLimit")) {
        if (patch.rateLimit === undefined) delete run.rateLimit;
        else run.rateLimit = clone(patch.rateLimit);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "cancelRequestedAt")) {
        if (patch.cancelRequestedAt === undefined) delete run.cancelRequestedAt;
        else run.cancelRequestedAt = patch.cancelRequestedAt;
      }
      if (patch.attempt !== undefined) run.attempt = patch.attempt;
      run.updatedAt = now();
      await this.persistState();
      return clone(run);
    });
  }

  async completeRun(runId: string, result: OrchestrationResult) {
    await this.ready();
    return this.enqueue(async () => {
      const run = this.state.runs[runId];
      if (!run) throw new Error(`Run ${runId} was not found`);
      if (run.status === "cancelled" || run.status === "cancelling") return clone(run);
      this.applyCompletion(run, result, now());
      await this.persistState();
      return clone(run);
    });
  }

  async prepareResume(runId: string) {
    await this.ready();
    return this.enqueue(async () => {
      const run = this.state.runs[runId];
      if (!run) throw new Error(`Run ${runId} was not found`);
      if (!["failed", "interrupted", "cancelled"].includes(run.status)) {
        throw new Error(`Run ${runId} cannot be resumed while it is ${run.status}`);
      }

      const previousAttempt = run.attempt;
      await this.archiveRunEvents(run.id, previousAttempt);
      const resumedAt = now();
      run.status = "queued";
      run.attempt += 1;
      run.usage = emptyRunUsage();
      run.attemptStartedAt = resumedAt;
      run.updatedAt = resumedAt;
      delete run.error;
      delete run.result;
      delete run.rateLimit;
      delete run.cancelRequestedAt;
      await this.persistState();
      await this.clearRunEvents(run.id);
      return clone(run);
    });
  }

  async appendRunEvent(record: RunEventRecord) {
    await this.ready();
    return this.enqueue(async () => {
      const path = this.eventsPath(record.event.runId);
      await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
    });
  }

  async readRunEvents(runId: string, after = 0): Promise<RunEventRecord[]> {
    await this.ready();
    await this.queue.catch(() => undefined);
    const records = await this.readRunEventFile(runId);
    return records.filter(record => record.seq > after);
  }

  private applyCompletion(run: StoredRun, result: OrchestrationResult, timestamp: string) {
    const conversation = this.state.conversations[run.conversationId];
    if (!conversation) throw new Error(`Conversation ${run.conversationId} was not found`);

    const existing = conversation.messages.find(message => message.runId === run.id && message.role === "assistant");
    if (existing) {
      existing.content = result.final;
      existing.createdAt = timestamp;
    } else {
      const assistantMessage = {
        id: randomUUID(),
        role: "assistant" as const,
        content: result.final,
        createdAt: timestamp,
        runId: run.id,
      };
      const userIndex = conversation.messages.findIndex(message => message.id === run.userMessageId);
      if (userIndex >= 0) {
        conversation.messages.splice(userIndex + 1, 0, assistantMessage);
      } else {
        conversation.messages.push(assistantMessage);
      }
    }

    conversation.updatedAt = laterTimestamp(conversation.updatedAt, timestamp);
    run.status = "completed";
    run.result = result;
    delete run.error;
    delete run.cancelRequestedAt;
    run.updatedAt = timestamp;
  }

  private async readRunEventFile(runId: string): Promise<RunEventRecord[]> {
    try {
      const raw = await readFile(this.eventsPath(runId), "utf8");
      const records: RunEventRecord[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as RunEventRecord);
        } catch {
          // A process can stop in the middle of its final append. Ignore only
          // that malformed record; earlier complete lines remain replayable.
        }
      }
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async tightenEventPermissions() {
    const entries = await readdir(this.runsDir, { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.endsWith(".ndjson"))
      .map(entry => chmod(join(this.runsDir, entry.name), 0o600)));
  }

  private async archiveRunEvents(runId: string, attempt: number) {
    const current = this.eventsPath(runId);
    const archive = join(this.runsDir, `${runId}.attempt-${attempt}.ndjson`);
    try {
      await rename(current, archive);
      await chmod(archive, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async clearRunEvents(runId: string) {
    const path = this.eventsPath(runId);
    try {
      await truncate(path, 0);
      await chmod(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeFile(path, "", { encoding: "utf8", mode: 0o600 });
        return;
      }
      throw error;
    }
  }

  private eventsPath(runId: string) {
    return join(this.runsDir, `${runId}.ndjson`);
  }

  private async ready() {
    if (!this.initialized) await this.init();
    await this.queue.catch(() => undefined);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persistState() {
    const temp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temp, 0o600);
    await rename(temp, this.statePath);
    await chmod(this.statePath, 0o600);
  }
}
