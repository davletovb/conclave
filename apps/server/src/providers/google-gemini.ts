import type {
  ModelRef,
  ProviderAdapter,
  ProviderEventSink,
  ProviderRequest,
  ProviderResponse,
  ProviderStatus,
} from "@conclave/core";
import {
  NativeAntigravityCliRunner,
  parseAntigravityModels,
  type AntigravityCliRunner,
  type AntigravityModel,
} from "../antigravity/cli.js";

type AntigravityUsage = {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
};

type AntigravityTerminalResult = {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  usage?: AntigravityUsage;
};

type AntigravityStreamEvent = {
  event?: string;
  step_update?: {
    state?: string;
    step_type?: string;
    tool_name?: string;
    text_delta?: string;
  };
  result?: AntigravityTerminalResult;
};

const LEGACY_GEMINI_ALIASES = new Set(["auto", "pro", "flash", "flash-lite"]);

const TEXT_ONLY_INSTRUCTIONS = [
  "You are responding inside Conclave, a multi-model reasoning interface.",
  "Answer the user's request directly as text.",
  "Do not use tools, read or write local files, execute commands, browse the web, call MCP servers, spawn subagents, or take external side effects.",
  "Do not reveal hidden chain-of-thought; provide concise conclusions and useful reasoning summaries instead.",
].join(" ");

function cancelledError() {
  const error = new Error("Antigravity CLI turn cancelled");
  error.name = "AbortError";
  return error;
}

function parseStreamEvent(rawLine: string): AntigravityStreamEvent | undefined {
  const line = rawLine.trim();
  if (!line) return undefined;
  try {
    return JSON.parse(line) as AntigravityStreamEvent;
  } catch {
    return undefined;
  }
}

function timeoutMsFromEnv() {
  const raw = Number(process.env.CONCLAVE_ANTIGRAVITY_TURN_TIMEOUT_MS ?? 180_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
}

function isLocalRuntimeFailure(message: string) {
  return /\b(?:ENOENT|EACCES|EPERM|ENOSPC|EROFS)\b|mkdtemp|read-only file system|permission denied/i.test(message);
}

function isAuthFailure(message: string) {
  return /authentication required|not authenticated|not signed in|sign[ -]?in required|login required|credentials? (?:are )?(?:missing|not found)/i.test(message);
}

function legacyModelMatch(alias: string, models: AntigravityModel[]) {
  if (alias === "pro") {
    return models.find(model => /(?:^|[-\s])pro(?:$|[-\s])/i.test(`${model.id} ${model.label}`));
  }
  if (alias === "flash-lite") {
    return models.find(model => /flash/i.test(`${model.id} ${model.label}`) && /lite/i.test(`${model.id} ${model.label}`));
  }
  if (alias === "flash") {
    return models.find(model => /flash/i.test(`${model.id} ${model.label}`) && !/lite/i.test(`${model.id} ${model.label}`));
  }
  return undefined;
}

export class GoogleGeminiProvider implements ProviderAdapter {
  readonly id = "google" as const;
  readonly label = "Google Gemini via Antigravity CLI";

  constructor(private readonly runner: AntigravityCliRunner = new NativeAntigravityCliRunner()) {}

  async status(): Promise<ProviderStatus> {
    try {
      const models = await this.discoverModels();
      return {
        id: this.id,
        label: this.label,
        available: true,
        connected: true,
        authMode: "google-account",
        message: `Using Google-account authentication through Antigravity CLI · ${models.length} Gemini model${models.length === 1 ? "" : "s"} available`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Antigravity CLI runtime unavailable";
      if (isLocalRuntimeFailure(message)) {
        const missing = /\bENOENT\b|not found/i.test(message);
        return {
          id: this.id,
          label: this.label,
          available: false,
          connected: false,
          message: missing
            ? `Antigravity CLI is not installed. ${message}`
            : `Antigravity CLI could not start on this machine. ${message}`,
        };
      }

      if (isAuthFailure(message)) {
        return {
          id: this.id,
          label: this.label,
          available: true,
          connected: false,
          authMode: "google-account",
          message: `Antigravity CLI is installed but Google-account authentication is not ready. Run \`agy\` in a terminal and sign in with Google, then restart Conclave. ${message}`,
        };
      }

      return {
        id: this.id,
        label: this.label,
        available: true,
        connected: false,
        authMode: "google-account",
        message: `Antigravity CLI could not expose Gemini models for Conclave. ${message}`,
      };
    }
  }

  async listModels(): Promise<ModelRef[]> {
    const models = await this.discoverModels();
    return models.map((model, index) => ({
      provider: "google" as const,
      model: model.id,
      label: model.label,
      source: "subscription" as const,
      isDefault: index === 0,
    }));
  }

  async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    if (request.signal?.aborted) throw cancelledError();
    if (!request.model.startsWith("gemini-") && !LEGACY_GEMINI_ALIASES.has(request.model)) {
      throw new Error(`Antigravity Google adapter refuses non-Gemini model: ${request.model}`);
    }

    const startedAt = Date.now();
    const timeoutMs = timeoutMsFromEnv();
    const printTimeout = `${Math.max(1, Math.ceil(timeoutMs / 1_000))}s`;
    const prompt = this.buildPrompt(request);
    const controller = new AbortController();
    let streamedText = "";
    let terminal: AntigravityTerminalResult | undefined;
    let toolViolation = "";

    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const resolvedModel = await this.resolveModel(request.model);
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", printTimeout,
      "--sandbox",
      "--mode=default",
    ];
    if (resolvedModel) args.push("--model", resolvedModel);
    const stdinText = `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;

    try {
      const result = await this.runner.run(args, timeoutMs + 5_000, rawLine => {
        const event = parseStreamEvent(rawLine);
        if (!event) return;

        if (event.event === "step_update") {
          const update = event.step_update;
          if (!update) return;

          if (update.step_type === "tool") {
            toolViolation = update.tool_name || "unknown tool";
            controller.abort();
            return;
          }

          if (update.step_type === "agent_response" && typeof update.text_delta === "string") {
            streamedText += update.text_delta;
            emit?.({ type: "text_delta", delta: update.text_delta });
          }
          return;
        }

        if (event.event === "result" && event.result) terminal = event.result;
      }, controller.signal, stdinText);

      if (toolViolation) {
        throw new Error(`Antigravity attempted a tool step (${toolViolation}); Conclave's Google provider is text-only.`);
      }
      if (request.signal?.aborted) throw cancelledError();
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
        throw new Error(`Antigravity CLI failed: ${detail}`);
      }

      if (!terminal) {
        for (const rawLine of result.stdout.split(/\r?\n/)) {
          const event = parseStreamEvent(rawLine);
          if (event?.event === "result" && event.result) terminal = event.result;
        }
      }

      if (!terminal) throw new Error("Antigravity CLI completed without a terminal result event");
      if (terminal.status !== "SUCCESS") {
        throw new Error(`Antigravity CLI ended with status ${terminal.status ?? "unknown"}${terminal.error ? `: ${terminal.error}` : ""}`);
      }

      const usage = terminal.usage;
      if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
        emit?.({
          type: "usage",
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        });
      }

      const content = terminal.response?.trim() || streamedText.trim();
      if (!content) {
        const zeroUsage = !usage || ((usage.input_tokens ?? 0) === 0 && (usage.output_tokens ?? 0) === 0);
        throw new Error(zeroUsage
          ? "Antigravity CLI reported success with an empty response and zero usage"
          : "Antigravity CLI completed without a text response");
      }

      // Short answers can arrive only in the terminal result. Preserve Conclave's
      // normalized text stream without duplicating deltas already observed.
      if (!streamedText) {
        emit?.({ type: "text_delta", delta: content });
      } else if (content.startsWith(streamedText)) {
        const suffix = content.slice(streamedText.length);
        if (suffix) emit?.({ type: "text_delta", delta: suffix });
      }

      return {
        provider: this.id,
        model: request.model,
        content,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (toolViolation) {
        throw new Error(`Antigravity attempted a tool step (${toolViolation}); Conclave's Google provider is text-only.`);
      }
      if (request.signal?.aborted) throw cancelledError();
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  private async resolveModel(requestedModel: string) {
    if (requestedModel === "auto") return undefined;
    if (requestedModel.startsWith("gemini-")) return requestedModel;

    // PR #22 briefly advertised these aliases. Persisted interrupted runs can be
    // resumed after this runtime migration, so map every old alias to the live
    // Antigravity catalog instead of failing before launch.
    const models = await this.discoverModels();
    return legacyModelMatch(requestedModel, models)?.id ?? models[0]?.id;
  }

  private async discoverModels() {
    const result = await this.runner.run(["models"], 15_000);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
      throw new Error(`Antigravity model discovery failed: ${detail}`);
    }

    const models = parseAntigravityModels(result.stdout);
    if (models.length === 0) {
      throw new Error("Antigravity exposed no Gemini models for the signed-in account");
    }
    return models;
  }

  private buildPrompt(request: ProviderRequest) {
    const parts = [TEXT_ONLY_INSTRUCTIONS];
    if (request.system) parts.push(`SYSTEM CONTEXT:\n${request.system}`);
    for (const message of request.messages) {
      parts.push(`${message.role.toUpperCase()}:\n${message.content}`);
    }
    return parts.join("\n\n");
  }
}
