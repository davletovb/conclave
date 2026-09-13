import { spawn } from "node:child_process";
import type {
  ModelRef,
  ProviderAdapter,
  ProviderEventSink,
  ProviderRequest,
  ProviderResponse,
  ProviderStatus,
} from "@conclave/core";

type ClaudeAuthStatus = {
  loggedIn?: boolean;
  authMethod?: string | null;
  apiProvider?: string | null;
  subscriptionType?: string | null;
  email?: string | null;
};

type RunResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export interface ClaudeCliRunner {
  run(
    args: string[],
    timeoutMs?: number,
    onStdoutLine?: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<RunResult>;
}

const CLAUDE_MODELS: ModelRef[] = [
  {
    provider: "anthropic",
    model: "sonnet",
    label: "Claude Sonnet",
    source: "subscription",
    isDefault: true,
  },
  {
    provider: "anthropic",
    model: "opus",
    label: "Claude Opus",
    source: "subscription",
  },
  {
    provider: "anthropic",
    model: "haiku",
    label: "Claude Haiku",
    source: "subscription",
  },
];

const TEXT_ONLY_SYSTEM = [
  "You are responding inside Conclave, a multi-model reasoning interface.",
  "Answer the user's request directly as text.",
  "Do not use tools, modify files, execute commands, or take external side effects.",
].join(" ");

function subscriptionOnlyEnv() {
  const env = { ...process.env };

  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;

  return env;
}

function cancelledError() {
  const error = new Error("Claude Code turn cancelled");
  error.name = "AbortError";
  return error;
}

function parseJsonLine(rawLine: string) {
  const line = rawLine.trim();
  if (!line) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function partialTextDelta(rawLine: string) {
  const outer = parseJsonLine(rawLine);
  if (outer?.type !== "stream_event") return "";
  const event = outer.event as Record<string, unknown> | undefined;
  if (event?.type !== "content_block_delta") return "";
  const delta = event.delta as Record<string, unknown> | undefined;
  return delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

function usageFromLine(rawLine: string) {
  const event = parseJsonLine(rawLine);
  if (!event) return undefined;
  const message = event.message as Record<string, unknown> | undefined;
  const usage = (event.usage ?? message?.usage) as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  const inputTokens = typeof input === "number" ? input : undefined;
  const outputTokens = typeof output === "number" ? output : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens, outputTokens };
}

export class NativeClaudeCliRunner implements ClaudeCliRunner {
  run(
    args: string[],
    timeoutMs = 180_000,
    onStdoutLine?: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (signal?.aborted) return Promise.reject(cancelledError());

    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, {
        env: subscriptionOnlyEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.kill("SIGTERM");
        reject(error);
      };

      const onAbort = () => finishReject(cancelledError());
      signal?.addEventListener("abort", onAbort, { once: true });

      timer = setTimeout(() => {
        finishReject(new Error("Claude CLI timed out"));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        const text = String(chunk);
        stdout += text;
        if (!onStdoutLine) return;

        lineBuffer += text;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) onStdoutLine(line);
      });
      child.stderr.on("data", chunk => { stderr += chunk; });

      child.once("error", error => finishReject(error));

      child.once("close", code => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (onStdoutLine && lineBuffer) onStdoutLine(lineBuffer);
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
  }
}

export class AnthropicClaudeProvider implements ProviderAdapter {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic via Claude Code";

  constructor(private readonly runner: ClaudeCliRunner = new NativeClaudeCliRunner()) {}

  async status(): Promise<ProviderStatus> {
    try {
      const auth = await this.readAuthStatus();
      if (!auth.loggedIn) {
        return {
          id: this.id,
          label: this.label,
          available: true,
          connected: false,
          message: "Claude Code is installed but not signed in. Run `claude auth login` and use your claude.ai account.",
        };
      }

      if (auth.authMethod !== "claude.ai" || (auth.apiProvider && auth.apiProvider !== "firstParty")) {
        return {
          id: this.id,
          label: this.label,
          available: true,
          connected: false,
          authMode: auth.authMethod ?? undefined,
          message: "Claude Code is not using claude.ai subscription authentication. Conclave will not use Console/API-key or cloud-provider billing.",
        };
      }

      return {
        id: this.id,
        label: this.label,
        available: true,
        connected: true,
        authMode: "claude.ai",
        planType: auth.subscriptionType ?? undefined,
        message: "Using Claude subscription through Claude Code print mode",
      };
    } catch (error) {
      return {
        id: this.id,
        label: this.label,
        available: false,
        connected: false,
        message: error instanceof Error ? error.message : "Claude Code runtime unavailable",
      };
    }
  }

  async listModels(): Promise<ModelRef[]> {
    await this.requireSubscriptionAccount();
    return CLAUDE_MODELS;
  }

  async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    if (request.signal?.aborted) throw cancelledError();
    await this.requireSubscriptionAccount(request.signal);
    const startedAt = Date.now();
    const prompt = this.buildPrompt(request);
    const timeoutMs = Number(process.env.CONCLAVE_CLAUDE_TURN_TIMEOUT_MS ?? 180_000);

    const result = await this.runner.run([
      "-p",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--safe-mode",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--tools", "",
      "--disallowedTools", "mcp__*",
      "--permission-mode", "dontAsk",
      "--max-turns", "1",
      "--model", request.model,
      "--system-prompt", TEXT_ONLY_SYSTEM,
      prompt,
    ], timeoutMs, line => {
      const delta = partialTextDelta(line);
      if (delta) emit?.({ type: "text_delta", delta });
      const usage = usageFromLine(line);
      if (usage) emit?.({ type: "usage", ...usage });
    }, request.signal);

    if (request.signal?.aborted) throw cancelledError();
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
      throw new Error(`Claude Code failed: ${detail}`);
    }

    const content = this.extractText(result.stdout);
    if (!content) {
      throw new Error("Claude Code completed without a text response");
    }

    return {
      provider: this.id,
      model: request.model,
      content,
      latencyMs: Date.now() - startedAt,
    };
  }

  private async readAuthStatus(signal?: AbortSignal): Promise<ClaudeAuthStatus> {
    const result = await this.runner.run(["auth", "status"], 15_000, undefined, signal);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      if (detail) throw new Error(`Claude Code authentication check failed: ${detail}`);
      return { loggedIn: false };
    }

    try {
      return JSON.parse(result.stdout) as ClaudeAuthStatus;
    } catch {
      throw new Error("Claude Code returned an unreadable authentication status");
    }
  }

  private async requireSubscriptionAccount(signal?: AbortSignal) {
    const auth = await this.readAuthStatus(signal);
    if (!auth.loggedIn) {
      throw new Error("Claude Code is not signed in. Run `claude auth login` and authenticate with your Claude subscription.");
    }
    if (auth.authMethod !== "claude.ai" || (auth.apiProvider && auth.apiProvider !== "firstParty")) {
      throw new Error("Claude Code is not using claude.ai subscription authentication. Conclave refuses Console/API-key and cloud-provider billing for this adapter.");
    }
    return auth;
  }

  private buildPrompt(request: ProviderRequest) {
    const parts: string[] = [];
    if (request.system) parts.push(`SYSTEM CONTEXT:\n${request.system}`);
    for (const message of request.messages) {
      parts.push(`${message.role.toUpperCase()}:\n${message.content}`);
    }
    return parts.join("\n\n");
  }

  private extractText(stdout: string) {
    const assistantChunks: string[] = [];
    let resultFallback = "";

    for (const rawLine of stdout.split(/\r?\n/)) {
      const event = parseJsonLine(rawLine);
      if (!event) continue;

      if (event.type === "assistant") {
        const message = event.message as Record<string, unknown> | undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const record = block as Record<string, unknown>;
          if (record.type === "text" && typeof record.text === "string") {
            assistantChunks.push(record.text);
          }
        }
      }

      if (event.type === "result" && typeof event.result === "string") {
        resultFallback = event.result;
      }
    }

    return assistantChunks.join("\n\n").trim() || resultFallback.trim();
  }
}
