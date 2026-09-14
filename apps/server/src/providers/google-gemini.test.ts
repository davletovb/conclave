import { describe, expect, it } from "vitest";
import type { AntigravityCliRunner, AntigravityRunResult } from "../antigravity/cli.js";
import { GoogleGeminiProvider } from "./google-gemini.js";

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

class FakeAntigravityRunner implements AntigravityCliRunner {
  calls: string[][] = [];
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
    JSON.stringify({ event: "init", conversation_id: "agy-1", init: { permission_mode: "request-review" } }),
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
  ): Promise<AntigravityRunResult> {
    this.calls.push(args);
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

  it("reports a missing agy executable as unavailable", async () => {
    const runner: AntigravityCliRunner = {
      run: async () => { throw new Error("spawn agy ENOENT"); },
    };
    const provider = new GoogleGeminiProvider(runner);

    await expect(provider.status()).resolves.toMatchObject({
      id: "google",
      available: false,
      connected: false,
    });
  });

  it("streams Antigravity answer deltas and maps terminal token usage", async () => {
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
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--sandbox");
    expect(args).toContain("--mode=default");
    expect(args).toContain("--model");
    expect(args).toContain("gemini-3.8-flash-high");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("-p") + 1]).toMatch(/Do not use tools/i);
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

  it("fails closed if Antigravity attempts a tool step", async () => {
    const runner = new FakeAntigravityRunner();
    runner.generateLines = [
      JSON.stringify({ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "run_command" } }),
    ];
    const provider = new GoogleGeminiProvider(runner);

    await expect(provider.generate({
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "Just answer." }],
    })).rejects.toThrow(/attempted a tool step.*run_command/i);
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
    runner.generateLines = [JSON.stringify({
      event: "result",
      result: {
        status: "SUCCESS",
        response: "",
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    })];
    const provider = new GoogleGeminiProvider(runner);

    await expect(provider.generate({
      model: "gemini-3.8-flash-high",
      messages: [{ role: "user", content: "Hello" }],
    })).rejects.toThrow(/empty response and zero usage/i);
  });
});
