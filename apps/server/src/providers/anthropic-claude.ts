import { spawn } from "node:child_process";
import type {
  ModelRef,
  ProviderAdapter,
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
  run(args: string[], timeoutMs?: number): Promise<RunResult>;
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

  // Claude Code gives environment credentials precedence over the saved
  // claude.ai login. Remove metered/platform routes so this adapter cannot
  // silently switch away from the user's Claude subscription.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;

  return env;
}

export class NativeClaudeCliRunner implements ClaudeCliRunner {
  run(args: string[], timeoutMs = 180_000): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, {
        env: subscriptionOnlyEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error("Claude CLI timed out"));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });

      child.once("error", error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.once("close", code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    await this.requireSubscriptionAccount();
    const startedAt = Date.now();
    const prompt = this.buildPrompt(request);
    const timeoutMs = Number(process.env.CONCLAVE_CLAUDE_TURN_TIMEOUT_MS ?? 180_000);

    const result = await this.runner.run([
      "-p",
      "--output-format", "stream-json",
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
    ], timeoutMs);

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

  private async readAuthStatus(): Promise<ClaudeAuthStatus> {
    const result = await this.runner.run(["auth", "status"], 15_000);
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

  private async requireSubscriptionAccount() {
    const auth = await this.readAuthStatus();
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
      const line = rawLine.trim();
      if (!line) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

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
