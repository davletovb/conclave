import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAntigravityChildEnv,
  CONCLAVE_ANTIGRAVITY_AGENT,
  createAntigravityWorkspace,
  NativeAntigravityCliRunner,
  parseAntigravityModels,
} from "./cli.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

describe("Antigravity CLI transport", () => {
  it("discovers only Gemini models from the live agy catalog", () => {
    const models = parseAntigravityModels([
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      "gpt-oss-120b-medium\tGPT OSS 120B (Medium)",
      "gemini-3.8-flash-high\tduplicate",
      "",
    ].join("\n"));

    expect(models).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    ]);
  });

  it("removes API/Vertex credentials and inherited Antigravity session plumbing", () => {
    const env = buildAntigravityChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/example",
      GEMINI_API_KEY: "secret",
      GOOGLE_API_KEY: "secret",
      GOOGLE_GENAI_API_KEY: "secret",
      ANTIGRAVITY_API_KEY: "secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_ACCESS_TOKEN: "token",
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_CLOUD_PROJECT_ID: "project-id",
      GOOGLE_CLOUD_QUOTA_PROJECT: "quota",
      GOOGLE_CLOUD_LOCATION: "global",
      CLOUD_ML_PROJECT_ID: "ml-project",
      GOOGLE_GEMINI_BASE_URL: "https://example.invalid",
      ANTIGRAVITY_CONVERSATION_ID: "private-session",
      ANTIGRAVITY_SOURCE_METADATA: "private-source",
      AGY_BROWSER_WS_URL: "ws://127.0.0.1:1234",
      AGY_BROWSER_ACTIVE_PORT_FILE: "/tmp/port",
      AGY_SIDECAR_PORT: "4567",
      ANTIGRAVITY_SIDECAR_PORT: "4568",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/example");
    for (const name of [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_API_KEY",
      "ANTIGRAVITY_API_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_CLOUD_ACCESS_TOKEN",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_PROJECT_ID",
      "GOOGLE_CLOUD_QUOTA_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "CLOUD_ML_PROJECT_ID",
      "GOOGLE_GEMINI_BASE_URL",
      "ANTIGRAVITY_CONVERSATION_ID",
      "ANTIGRAVITY_SOURCE_METADATA",
      "AGY_BROWSER_WS_URL",
      "AGY_BROWSER_ACTIVE_PORT_FILE",
      "AGY_SIDECAR_PORT",
      "ANTIGRAVITY_SIDECAR_PORT",
    ]) {
      expect(Object.hasOwn(env, name)).toBe(false);
    }
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
  });

  it("creates a workspace-local primary agent with no inherited customizations or execution capabilities", () => {
    const workspace = createAntigravityWorkspace();
    try {
      const definition = readFileSync(
        join(workspace, ".agents", "agents", CONCLAVE_ANTIGRAVITY_AGENT, "agent.md"),
        "utf8",
      );
      expect(definition).toContain("tools: []");
      expect(definition).toContain("mainAgent: true");
      expect(definition).toContain("subagent: false");
      expect(definition).toContain("inheritCustomizations: false");
      expect(definition).toContain("inheritMcp: false");
      expect(definition).toContain('commandExecutionPolicy: "off"');
      expect(definition).toContain("mcpServers: []");
      expect(definition).toContain("skills: []");
      expect(definition).toContain("plugins: []");
      expect(definition).toContain("rules: []");
      expect(definition).toContain("agents: []");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the child workspace until an aborted process has actually closed", async () => {
    if (process.platform === "win32") return;

    const root = mkdtempSync(join(tmpdir(), "conclave-agy-lifecycle-test-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { mode: 0o700 });
    const script = [
      'console.log("ready")',
      'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 150))',
      'setInterval(() => {}, 1000)',
    ].join(";");
    const runner = new NativeAntigravityCliRunner({
      command: process.execPath,
      prefixArgs: ["-e", script, "--"],
      createWorkspace: () => workspace,
    });
    const controller = new AbortController();
    let existedAtAbort = false;

    try {
      const pending = runner.run(["ignored"], 5_000, line => {
        if (line !== "ready") return;
        existedAtAbort = existsSync(workspace);
        controller.abort();
      }, controller.signal);

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(existedAtAbort).toBe(true);
      expect(existsSync(workspace)).toBe(true);
      await waitUntil(() => !existsSync(workspace));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
