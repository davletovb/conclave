import type {
  ModelRef,
  ProviderAdapter,
  ProviderEventSink,
  ProviderRequest,
  ProviderResponse,
  ProviderStatus,
} from "@conclave/core";
import { CodexAppServerClient, type CodexClientLike, type CodexNotification } from "../codex/app-server-client.js";

type AccountReadResponse = {
  account: null | {
    type: "apiKey" | "chatgpt" | "amazonBedrock";
    email?: string | null;
    planType?: string;
  };
  requiresOpenaiAuth: boolean;
};

type ModelListResponse = {
  data: Array<{
    id?: string;
    model: string;
    displayName?: string;
    hidden?: boolean;
    isDefault?: boolean;
  }>;
};

type ThreadStartResponse = { thread: { id: string } };
type TurnStartResponse = { turn: { id: string } };

type AgentMessageItem = { type: "agentMessage"; text: string };
type TurnCompletedParams = {
  threadId?: string;
  turn?: {
    id?: string;
    status?: string;
    error?: { message?: string } | null;
    items?: Array<Record<string, unknown>>;
  };
};

const TEXT_ONLY_INSTRUCTIONS = [
  "You are responding inside Conclave, a multi-model reasoning interface.",
  "Answer the user's request directly as text.",
  "Do not modify files, execute commands, or take external side effects.",
].join(" ");

function isAgentMessage(item: Record<string, unknown>): item is Record<string, unknown> & AgentMessageItem {
  return item.type === "agentMessage" && typeof item.text === "string";
}

export class OpenAICodexProvider implements ProviderAdapter {
  readonly id = "openai" as const;
  readonly label = "OpenAI via Codex";

  constructor(private readonly client: CodexClientLike = new CodexAppServerClient()) {}

  async status(): Promise<ProviderStatus> {
    try {
      const account = await this.readAccount();
      if (account.account?.type === "chatgpt") {
        return {
          id: this.id,
          label: this.label,
          available: true,
          connected: true,
          authMode: "chatgpt",
          planType: account.account.planType,
          message: "Using ChatGPT subscription through Codex",
        };
      }

      if (account.account?.type === "apiKey") {
        return {
          id: this.id,
          label: this.label,
          available: true,
          connected: false,
          authMode: "apiKey",
          message: "Codex is signed in with an API key. Conclave will not use it, to avoid API billing.",
        };
      }

      return {
        id: this.id,
        label: this.label,
        available: true,
        connected: false,
        message: account.requiresOpenaiAuth
          ? "Codex is installed but not signed in with ChatGPT."
          : "Codex is available, but no ChatGPT subscription account is active.",
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        connected: false,
        message: error instanceof Error ? error.message : "Codex runtime unavailable",
      };
    }
  }

  async listModels(): Promise<ModelRef[]> {
    await this.requireChatGptAccount();
    const response = await this.client.request<ModelListResponse>("model/list", {
      limit: 100,
      includeHidden: false,
    });

    return response.data
      .filter(model => !model.hidden)
      .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
      .map(model => ({
        provider: this.id,
        model: model.model ?? model.id ?? "",
        label: model.displayName ?? model.model ?? model.id ?? "OpenAI model",
        source: "subscription" as const,
        isDefault: Boolean(model.isDefault),
      }))
      .filter(model => Boolean(model.model));
  }

  async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    await this.requireChatGptAccount();
    const startedAt = Date.now();
    const prompt = this.buildPrompt(request);

    const thread = await this.client.request<ThreadStartResponse>("thread/start", {
      model: request.model,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: TEXT_ONLY_INSTRUCTIONS,
    });

    const content = await this.runTurn(thread.thread.id, request.model, prompt, emit);
    return {
      provider: this.id,
      model: request.model,
      content,
      latencyMs: Date.now() - startedAt,
    };
  }

  close() {
    this.client.close();
  }

  private async readAccount() {
    return this.client.request<AccountReadResponse>("account/read", { refreshToken: false });
  }

  private async requireChatGptAccount() {
    const response = await this.readAccount();
    if (response.account?.type === "chatgpt") return response.account;
    if (response.account?.type === "apiKey") {
      throw new Error("Codex is authenticated with an API key. Conclave is subscription-only and refuses API-key billing. Sign out of Codex and sign in with ChatGPT.");
    }
    throw new Error("Codex is not signed in with ChatGPT. Run `codex` and choose Sign in with ChatGPT, then restart Conclave.");
  }

  private buildPrompt(request: ProviderRequest) {
    const parts: string[] = [];
    if (request.system) parts.push(`System instruction:\n${request.system}`);
    for (const message of request.messages) {
      parts.push(`${message.role.toUpperCase()}:\n${message.content}`);
    }
    return parts.join("\n\n");
  }

  private async runTurn(threadId: string, model: string, prompt: string, emit?: ProviderEventSink) {
    let expectedTurnId: string | null = null;
    const completedTurns = new Map<string, TurnCompletedParams>();
    const completedMessages = new Map<string, string[]>();
    const streamedText = new Map<string, string>();

    let resolveDone!: (value: TurnCompletedParams) => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<TurnCompletedParams>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const unsubscribe = this.client.onNotification((notification: CodexNotification) => {
      const params = notification.params ?? {};
      const notificationThreadId = typeof params.threadId === "string" ? params.threadId : undefined;
      if (notificationThreadId && notificationThreadId !== threadId) return;

      const directTurnId = typeof params.turnId === "string" ? params.turnId : undefined;
      const nestedTurn = params.turn as Record<string, unknown> | undefined;
      const nestedTurnId = typeof nestedTurn?.id === "string" ? nestedTurn.id : undefined;
      const turnId = directTurnId ?? nestedTurnId;
      if (!turnId) return;

      if (notification.method === "item/agentMessage/delta") {
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (delta) {
          streamedText.set(turnId, `${streamedText.get(turnId) ?? ""}${delta}`);
          emit?.({ type: "text_delta", delta });
        }
        return;
      }

      if (notification.method === "item/completed") {
        const item = params.item as Record<string, unknown> | undefined;
        if (item && isAgentMessage(item)) {
          const messages = completedMessages.get(turnId) ?? [];
          messages.push(item.text);
          completedMessages.set(turnId, messages);
        }
        return;
      }

      if (notification.method === "turn/completed") {
        const completion = params as TurnCompletedParams;
        completedTurns.set(turnId, completion);
        if (turnId === expectedTurnId) resolveDone(completion);
      }

      if (notification.method === "error" && turnId === expectedTurnId) {
        const message = typeof params.message === "string" ? params.message : "Codex turn failed";
        rejectDone(new Error(message));
      }
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      const turn = await this.client.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        model,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      expectedTurnId = turn.turn.id;

      const earlyCompletion = completedTurns.get(expectedTurnId);
      if (earlyCompletion) resolveDone(earlyCompletion);

      const timeoutMs = Number(process.env.CONCLAVE_CODEX_TURN_TIMEOUT_MS ?? 180_000);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Codex turn timed out")), timeoutMs);
      });
      const completion = await Promise.race([done, timeoutPromise]);

      const status = completion.turn?.status;
      if (status && status !== "completed") {
        throw new Error(completion.turn?.error?.message ?? `Codex turn ended with status ${status}`);
      }

      const eventMessages = completedMessages.get(expectedTurnId) ?? [];
      const turnMessages = (completion.turn?.items ?? [])
        .filter(isAgentMessage)
        .map(item => item.text);
      const content = eventMessages.join("\n\n").trim()
        || turnMessages.join("\n\n").trim()
        || (streamedText.get(expectedTurnId) ?? "").trim();
      if (!content) throw new Error("Codex completed without an assistant message");
      return content;
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    }
  }
}
