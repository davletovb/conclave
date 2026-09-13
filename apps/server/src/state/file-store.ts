import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, truncate, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatMessage,
  Conversation,
  ConversationSummary,
  OrchestrationRequest,
  OrchestrationResult,
  RunEventRecord,
  RunStatus,
  StoredRun,
} from "@conclave/core";

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
      await mkdir(this.runsDir, { recursive: true });
      try {
        const raw = await readFile(this.statePath, "utf8");
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed.version !== 1) throw new Error(`Unsupported Conclave state version: ${parsed.version}`);
        this.state = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.persistState();
      }

      let changed = false;
      const timestamp = now();
      for (const run of Object.values(this.state.runs)) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "interrupted";
          run.updatedAt = timestamp;
          run.error = "Conclave stopped before this run completed. Resume it to start a new attempt.";
          changed = true;
        }
      }
      if (changed) await this.persistState();
      this.initialized = true;
    });
  }

  async listConversations(): Promise<ConversationSummary[]> {
    await this.ready();
    return Object.values(this.state.conversations)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(conversation => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        lastRunId: conversation.lastRunId,
        messageCount: conversation.messages.length,
      }));
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
        request: cleanRequest(request),
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
      if (Object.prototype.hasOwnProperty.call(patch, "error")) {
        if (patch.error === undefined) delete run.error;
        else run.error = patch.error;
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
      const conversation = this.state.conversations[run.conversationId];
      if (!conversation) throw new Error(`Conversation ${run.conversationId} was not found`);
      const timestamp = now();

      const existing = conversation.messages.find(message => message.runId === runId && message.role === "assistant");
      if (existing) {
        existing.content = result.final;
        existing.createdAt = timestamp;
      } else {
        const assistantMessage = {
          id: randomUUID(),
          role: "assistant" as const,
          content: result.final,
          createdAt: timestamp,
          runId,
        };
        const userIndex = conversation.messages.findIndex(message => message.id === run.userMessageId);
        if (userIndex >= 0) {
          conversation.messages.splice(userIndex + 1, 0, assistantMessage);
        } else {
          conversation.messages.push(assistantMessage);
        }
      }
      conversation.updatedAt = timestamp;
      run.status = "completed";
      run.result = result;
      delete run.error;
      run.updatedAt = timestamp;
      await this.persistState();
      return clone(run);
    });
  }

  async prepareResume(runId: string) {
    await this.ready();
    return this.enqueue(async () => {
      const run = this.state.runs[runId];
      if (!run) throw new Error(`Run ${runId} was not found`);
      if (run.status !== "failed" && run.status !== "interrupted") {
        throw new Error(`Run ${runId} cannot be resumed while it is ${run.status}`);
      }
      run.status = "queued";
      run.attempt += 1;
      run.updatedAt = now();
      delete run.error;
      delete run.result;
      await this.persistState();
      await this.clearRunEvents(run.id);
      return clone(run);
    });
  }

  async appendRunEvent(record: RunEventRecord) {
    await this.ready();
    return this.enqueue(async () => {
      await appendFile(this.eventsPath(record.event.runId), `${JSON.stringify(record)}\n`, "utf8");
    });
  }

  async readRunEvents(runId: string, after = 0): Promise<RunEventRecord[]> {
    await this.ready();
    await this.queue.catch(() => undefined);
    try {
      const raw = await readFile(this.eventsPath(runId), "utf8");
      return raw.split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line) as RunEventRecord)
        .filter(record => record.seq > after);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async clearRunEvents(runId: string) {
    const path = this.eventsPath(runId);
    try {
      await truncate(path, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await writeFile(path, "", "utf8");
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
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temp, this.statePath);
  }
}
