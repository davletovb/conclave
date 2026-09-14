import { describe, expect, it } from "vitest";
import {
  CONCLAVE_ANTIGRAVITY_AGENT,
  type AntigravityCliRunner,
  type AntigravityRunResult,
} from "../antigravity/cli.js";
import { GoogleGeminiProvider } from "./google-gemini.js";

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function initLine(permissionMode = "request-review", tools: string[] = [], agent = CONCLAVE_ANTIGRAVITY_AGENT) {
  return JSON.stringify({
    event: "init",
    conversation_id: "agy-1",
    init: {
      permission_mode: permissionMode,
      agent,
      tools,
    },
  });
}

class FakeAntigravityRunner implements AntigravityCliRunner {
  calls: string[][] = [];
  stdinTexts: Array<string | undefined> = [];
  modelsResult: AntigravityRunResult = {
    code: 0,
    stderr: "",
    stdout: [
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
    ].join("\n"),
  };
  generateLines = [
    initLine(),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "Gemini subscription " } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", state: "DONE", text_delta: "answer" } }),
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "agy-1",
        status: "SUCCESS",
        response: "Gemini subscription answer\n",
        usage: { input_tokens: 17, output_tokens: 9, thinking_tokens: 3, total_tokens: 26 },
      },
    }),
  ];
  generateCode = 0;
  generateStderr = "";
  holdGenerate = false;

  async run(
    args: string[],
    _timeoutMs?: number,
    onStdoutLine?: (line: string) => void,
    signal?: AbortSignal,
    stdinText?: string,
  ): Promise<AntigravityRunResult> {
    this.calls.push(args);
    this.stdinTexts.push(stdinText);
    if (args[0] === "models") return this.modelsResult;

    if (this.holdGenerate) {
      return new Promise<AntigravityRunResult>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      });
    }

    for (const line of this.generateLines) {
      onStdoutLine?.(line);
      if (signal?.aborted) throw abortError();
    }

    return {
      code: this.generateCode,
      stderr: this.generateStderr,
      stdout: `${this.generateLines.join("\n")}\n`,
    };
  }
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for condition");
}

describe("GoogleGeminiProvider via Antigravity CLI", () => {
  it("uses the live Antigravity model catalog and exposes only Gemini models", async () => {
    const runner = new FakeAntigravityRunner();
    const provider = new GoogleGeminiProvider(runner);

    const models = await provider.listModels();

    expect(models.map(model => model.model)).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
    ]);
    expect(models[0]).toMatchObject({
      provider: "google",
      label: "Gemini 3.8 Flash (High)",
      source: "subscription",
      isDefault: true,
    });
    expect(runner.calls).toEqual([["models"]]);
  });

  it("reports a signed-in Antigravity runtime as connected", async () => {
    const provider = new GoogleGeminiProvider(new FakeAntigravityRunner());

    await expect(provider.status()).resolves.toMatchObject({
      id: "google",
      available: true,
      connected: true,
      authMode: "google-account",
    });
  });

  it("keeps an installed but signed-out Antigravity runtime available with login remediation", async () => {
    const runner = new FakeAntigravityRunner();
    runner.modelsResult = { code: 1, stdout: "", stderr: "authentication required" };
    const provider = new GoogleGeminiProvider(runner);

    const status = await provider.status();

    expect(status).toMatchObject({
      id: "google",
      available: true,
      connected: false,
      authMode: "google-account",
    });
    expect(status.message).toMatch(/run `agy`/i);
  });

  it("reports missing or locally unusable Antigravity runtimes as unavailable", async () => {
    for (const failure of [
      "spawn agy ENOENT",
      "spawn agy EACCES",
      "ENOSPC: no space left on device, mkdtemp",
    ]) {
      const runner: AntigravityCliRunner = {
        run: async () => { throw new Error(failure); },
      };
      const provider = new GoogleGeminiProvider(runner);

      await expect(provider.status()).resolves.toMatchObject({
        id: "google",
        available: false,
        connected: false,
      });
    }
  });

  it("refuses Antigravity direct Gemini API-key mode", async () => {
    const runner = new FakeAntigravityRunner();
    runner.modelsResult = {
      code: 1,
      stdout: "",
      stderr: "GEMINI_API_KEY is required when modelProvider is gemini",
    };
    const provider = new GoogleGeminiProvider(runner);

    const status = await provider.status();

    expect(status).toMatchObject({
      id: "google",
      available: true,
      connected: false,
      authMode: "google-account",
    });
    expect(status.message).toMatch(/direct Gemini API-key mode/i);
    expect(status.message).toMatch(/modelProvider/i);
  });

  it("streams answer deltas through the workspace-local tool-free agent and stdin", async () => {
    const runner = new FakeAntigravityRunner();
    const provider = new GoogleGeminiProvider(runner);
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    const response = await provider.generate({
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "Compare the designs." }],
    }, event => events.push(event));

    expect(response).toMatchObject({
      provider: "google",
      model: "gemini-3.8-flash-high",
      content: "Gemini subscription answer",
    });
    expect(events.filter(event => event.type === "text_delta").map(event => event.delta).join(""))
      .toBe("Gemini subscription answer");
    expect(events).toContainEqual({ type: "usage", inputTokens: 17, outputTokens: 9 });

    const args = runner.calls[0];
    expect(args).toContain("--input-format");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--sandbox");
    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe(CONCLAVE_ANTIGRAVITY_AGENT);
    expect(args).not.toContain("--mode=default");
    expect(args).toContain("--model");
    expect(args).toContain("gemini-3.8-flash-high");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args.join(" ")).not.toContain("Compare the designs.");

    const input = JSON.parse(runner.stdinTexts[0]!.trim()) as {
      event: string;
      message: { content: string };
    };
    expect(input.event).toBe("user");
    expect(input.message.content).toMatch(/Do not use tools/i);
    expect(input.message.content).toContain("Compare the designs.");
  });

  it("accepts every documented non-auto-approve permission mode when the init tool list is empty", async () => {
    for (const mode of ["request-review", "proceed-in-sandbox", "strict"]) {
      const runner = new FakeAntigravityRunner();
      runner.generateLines[0] = initLine(mode);
      const provider = new GoogleGeminiProvider(runner);

      await expect(provider.generate({
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "Hello" }],
      })).resolves.toMatchObject({ content: "Gemini subscription answer" });
    }
  });

  it("keeps the old auto model id compatible by letting Antigravity choose its default", async () => {
    const runner = new FakeAntigravityRunner();
    const provider = new GoogleGeminiProvider(runner);

    await provider.generate({
      model: "auto",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(runner.calls[0]).not.toContain("--model");
  });

  it("maps every previously advertised Gemini alias onto the live Antigravity catalog", async () => {
    const catalog = [
      "gemini-3.8-pro-high\tGemini 3.8 Pro (High)",
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-lite\tGemini 3.8 Flash Lite",
    ].join("\n");
    const expected = new Map([
      ["pro", "gemini-3.8-pro-high"],
      ["flash", "gemini-3.8-flash-high"],
      ["flash-lite", "gemini-3.8-flash-lite"],
    ]);

    for (const [legacy, resolved] of expected) {
      const runner = new FakeAntigravityRunner();
      runner.modelsResult = { code: 0, stdout: catalog, stderr: "" };
      const provider = new GoogleGeminiProvider(runner);

      await provider.generate({
        model: legacy,
        messages: [{ role: "user", content: "Resume the old run." }],
      });

      expect(runner.calls[0]).toEqual(["models"]);
      const generationArgs = runner.calls[1];
      expect(generationArgs[generationArgs.indexOf("--model") + 1]).toBe(resolved);
    }
  });

  it("falls back to the live default when an old alias has no direct equivalent", async () => {
    const runner = new FakeAntigravityRunner();
    runner.modelsResult = {
      code: 0,
      stderr: "",
      stdout: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    };
    const provider = new GoogleGeminiProvider(runner);

    await provider.generate({
      model: "pro",
      messages: [{ role: "user", content: "Resume safely." }],
    });

    expect(runner.calls[1][runner.calls[1].indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
  });

  it("fails closed if Antigravity advertises any tools for the Conclave agent", async () => {
    const runner = new FakeAntigravityRunner();
    runner.generateLines = [initLine("request-review", ["write_file"] )];
    const provider = new GoogleGeminiProvider(runner);

    await expect(provider.generate({
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "Just answer." }],
    })).rejects.toThrow(/expected zero available tools.*write_file/i);
  });

  it("fails closed when the init agent is missing or not Conclave's tool-free agent", async () => {
    for (const agent of ["default", ""]) {
      const runner = new FakeAntigravityRunner();
      runner.generateLines = [initLine("request-review", [], agent)];
      const provider = new GoogleGeminiProvider(runner);

      await expect(provider.generate({
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "Just answer." }],
      })).rejects.toThrow(/expected agent conclave-text/i);
    }
  });

  it("fails closed when the stream omits init entirely", async () => {
    const runner = new FakeAntigravityRunner();
    runner.generateLines = [JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "unverified", usage: { output_tokens: 1 } },
    })];
    const provider = new GoogleGeminiProvider(runner);

    await expect(provider.generate({
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "Just answer." }],
    })).rejects.toThrow(/without a verifiable tool-free init event/i);
  });

  it("fails closed if tool or subagent activity appears after a verified tool-free init", async () => {
    for (const violatingStep of [
      { step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: {} },
      { step_type: "checkpoint", state: "ACTIVE", subagent_info: { conversation_id: "child" } },
    ]) {
      const runner = new FakeAntigravityRunner();
      runner.generateLines = [
        initLine(),
        JSON.stringify({ event: "step_update", step_update: violatingStep }),
      ];
      const provider = new GoogleGeminiProvider(runner);

      await expect(provider.generate({
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "Just answer." }],
      })).rejects.toThrow(/tool\/subagent step/i);
    }
  });

  it("fails closed when Antigravity starts in always-proceed or an unknown permission mode", async () => {
    for (const mode of ["always-proceed", "mystery-mode"]) {
      const runner = new FakeAntigravityRunner();
      runner.generateLines = [initLine(mode)];
      const provider = new GoogleGeminiProvider(runner);

      await expect(provider.generate({
        model: "gemini-3.8-flash-high",
        messages: [{ role: "user", content: "Just answer." }],
      })).rejects.toThrow(/permission mode .* is not one of/i);
    }
  });

  it("propagates Conclave cancellation into the Antigravity process", async () => {
    const runner = new FakeAntigravityRunner();
    runner.holdGenerate = true;
    const provider = new GoogleGeminiProvider(runner);
    const controller = new AbortController();

    const pending = provider.generate({
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "Keep thinking." }],
      signal: controller.signal,
    });

    await waitUntil(() => runner.calls.length === 1);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses non-Gemini Antigravity models", async () => {
    const provider = new GoogleGeminiProvider(new FakeAntigravityRunner());

    await expect(provider.generate({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow(/refuses non-Gemini model/i);
  });

  it("treats Antigravity's empty zero-usage success signature as a failure", async () => {
    const runner = new FakeAntigravityRunner();
    runner.generateLines = [
      initLine(),
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "",
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      }),
    ];
    const provider = new GoogleGeminiProvider(runner);

    await expect(provider.generate({
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow(/empty response and zero usage/i);
  });
});
