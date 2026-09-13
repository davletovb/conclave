import { describe, expect, it } from "vitest";
import { AnthropicClaudeProvider, type ClaudeCliRunner } from "./anthropic-claude.js";

type PlannedRun = {
  stdout: string;
  stderr?: string;
  code?: number;
};

class FakeClaudeRunner implements ClaudeCliRunner {
  calls: Array<{ args: string[]; timeoutMs?: number; signal?: AbortSignal }> = [];
  planned: PlannedRun[] = [];
  holdAuth = false;

  async run(
    args: string[],
    timeoutMs?: number,
    _onStdoutLine?: (line: string) => void,
    signal?: AbortSignal,
  ) {
    this.calls.push({ args, timeoutMs, signal });

    if (this.holdAuth && args[0] === "auth") {
      return new Promise<never>((_resolve, reject) => {
        const fail = () => {
          const error = new Error("Claude Code turn cancelled");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
      });
    }

    const next = this.planned.shift();
    if (!next) throw new Error(`Unexpected Claude CLI call: ${args.join(" ")}`);
    return {
      stdout: next.stdout,
      stderr: next.stderr ?? "",
      code: next.code ?? 0,
    };
  }
}

const subscriptionAuth = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "max",
  email: "test@example.com",
});

async function waitForCall(runner: FakeClaudeRunner) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (runner.calls.length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("Claude runner was not called");
}

describe("AnthropicClaudeProvider", () => {
  it("reports a connected claude.ai subscription and exposes safe model aliases", async () => {
    const runner = new FakeClaudeRunner();
    runner.planned.push({ stdout: subscriptionAuth }, { stdout: subscriptionAuth });
    const provider = new AnthropicClaudeProvider(runner);

    const status = await provider.status();
    const models = await provider.listModels();

    expect(status).toMatchObject({
      connected: true,
      authMode: "claude.ai",
      planType: "max",
    });
    expect(models.map(model => model.model)).toEqual(["sonnet", "opus", "haiku"]);
    expect(models[0]).toMatchObject({ source: "subscription", isDefault: true });
  });

  it("refuses Console/API authentication instead of risking metered billing", async () => {
    const runner = new FakeClaudeRunner();
    const consoleAuth = JSON.stringify({
      loggedIn: true,
      authMethod: "console",
      apiProvider: "firstParty",
      subscriptionType: null,
    });
    runner.planned.push({ stdout: consoleAuth }, { stdout: consoleAuth });
    const provider = new AnthropicClaudeProvider(runner);

    const status = await provider.status();
    expect(status.connected).toBe(false);
    await expect(provider.listModels()).rejects.toThrow(/refuses Console\/API-key/i);
  });

  it("runs Claude in tool-free ephemeral print mode and extracts assistant text", async () => {
    const runner = new FakeClaudeRunner();
    runner.planned.push(
      { stdout: subscriptionAuth },
      {
        stdout: [
          JSON.stringify({ type: "system", subtype: "init" }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "Real Claude subscription answer" }] },
          }),
          JSON.stringify({ type: "result", subtype: "success", result: "Real Claude subscription answer" }),
        ].join("\n"),
      },
    );
    const provider = new AnthropicClaudeProvider(runner);

    const response = await provider.generate({
      model: "sonnet",
      messages: [{ role: "user", content: "Compare the designs." }],
    });

    expect(response.content).toBe("Real Claude subscription answer");
    const printCall = runner.calls[1]?.args ?? [];
    expect(printCall).toContain("-p");
    expect(printCall).toContain("--safe-mode");
    expect(printCall).toContain("--no-session-persistence");
    expect(printCall).toContain("--tools");
    expect(printCall).toContain("");
    expect(printCall).toContain("--disallowedTools");
    expect(printCall).toContain("mcp__*");
    expect(printCall).toContain("--model");
    expect(printCall).toContain("sonnet");
  });

  it("cancels promptly while the subscription auth check is still running", async () => {
    const runner = new FakeClaudeRunner();
    runner.holdAuth = true;
    const provider = new AnthropicClaudeProvider(runner);
    const controller = new AbortController();

    const promise = provider.generate({
      model: "sonnet",
      messages: [{ role: "user", content: "Stop before generation starts." }],
      signal: controller.signal,
    });

    await waitForCall(runner);
    expect(runner.calls[0]?.args).toEqual(["auth", "status"]);
    expect(runner.calls[0]?.signal).toBe(controller.signal);

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(runner.calls).toHaveLength(1);
  });

  it("uses the result event as a fallback when no assistant event is emitted", async () => {
    const runner = new FakeClaudeRunner();
    runner.planned.push(
      { stdout: subscriptionAuth },
      { stdout: JSON.stringify({ type: "result", subtype: "success", result: "Fallback result" }) },
    );
    const provider = new AnthropicClaudeProvider(runner);

    const response = await provider.generate({
      model: "haiku",
      messages: [{ role: "user", content: "Say hello." }],
    });

    expect(response.content).toBe("Fallback result");
  });
});
