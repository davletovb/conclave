import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AntigravityRunResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export type AntigravityModel = {
  id: string;
  label: string;
};

export interface AntigravityCliRunner {
  run(
    args: string[],
    timeoutMs?: number,
    onStdoutLine?: (line: string) => void,
    signal?: AbortSignal,
    stdinText?: string,
  ): Promise<AntigravityRunResult>;
}

export const CONCLAVE_ANTIGRAVITY_AGENT = "conclave-text";

const CONCLAVE_AGENT_DEFINITION = `---
name: conclave-text
description: Text-only Conclave responder with no local or external tools.
tools: []
mainAgent: true
subagent: false
inheritMcp: false
commandExecutionPolicy: "off"
mcpServers: []
skills: []
plugins: []
---
# System Prompt
Return a direct text answer only. Do not use tools, subagents, files, commands, browsers, MCP servers, skills, plugins, or external side effects.
`;

const BLOCKED_BILLING_ENV = [
  "ANTIGRAVITY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "CLOUD_ML_PROJECT_ID",
  "GOOGLE_GEMINI_BASE_URL",
] as const;

const ISOLATED_RUNTIME_ENV = [
  /^ANTIGRAVITY_CONVERSATION_ID$/,
  /^ANTIGRAVITY_SOURCE_METADATA$/,
  /^ANTIGRAVITY_.*(?:BROWSER|SIDECAR).*$/,
  /^AGY_(?:BROWSER|SIDECAR)_.*$/,
] as const;

export function buildAntigravityChildEnv(source: NodeJS.ProcessEnv = process.env) {
  const env = { ...source };

  // Antigravity's documented direct Gemini API route reads GEMINI_API_KEY only
  // from the process environment and does not load .env files. Remove billing
  // credentials entirely so account/keyring auth remains the only usable route.
  // If the user's settings.json still selects modelProvider="gemini", agy fails
  // closed and the provider explains how to revert to account authentication.
  for (const name of BLOCKED_BILLING_ENV) delete env[name];

  // A parent agy session exports conversation/browser/sidecar plumbing to child
  // processes. Conclave starts independent one-shot sessions, so never inherit
  // that state from the shell that happened to launch pnpm dev.
  for (const name of Object.keys(env)) {
    if (ISOLATED_RUNTIME_ENV.some(pattern => pattern.test(name))) delete env[name];
  }

  // Conclave owns provider lifecycle; avoid a background self-updater racing a run.
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  return env;
}

export function parseAntigravityModels(stdout: string): AntigravityModel[] {
  const seen = new Set<string>();
  const models: AntigravityModel[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, id, label] = match;
    if (!id.startsWith("gemini-") || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: label.trim() });
  }

  return models;
}

function cancelledError() {
  const error = new Error("Antigravity CLI turn cancelled");
  error.name = "AbortError";
  return error;
}

function terminateProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to killing the direct child if process-group signaling is
      // unavailable (for example, if spawn failed before the group existed).
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best effort: the process may already have exited between checks.
  }
}

export function createAntigravityWorkspace() {
  const workspaceDir = mkdtempSync(join(tmpdir(), "conclave-agy-"));
  try {
    chmodSync(workspaceDir, 0o700);
    const agentDir = join(workspaceDir, ".agents", "agents", CONCLAVE_ANTIGRAVITY_AGENT);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, "agent.md"), CONCLAVE_AGENT_DEFINITION, {
      encoding: "utf8",
      mode: 0o600,
    });
    return workspaceDir;
  } catch (error) {
    rmSync(workspaceDir, { recursive: true, force: true });
    throw error;
  }
}

export type NativeAntigravityCliRunnerOptions = {
  command?: string;
  prefixArgs?: string[];
  createWorkspace?: () => string;
  cleanupWorkspace?: (workspaceDir: string) => void;
};

export class NativeAntigravityCliRunner implements AntigravityCliRunner {
  constructor(private readonly options: NativeAntigravityCliRunnerOptions = {}) {}

  run(
    args: string[],
    timeoutMs = 180_000,
    onStdoutLine?: (line: string) => void,
    signal?: AbortSignal,
    stdinText?: string,
  ): Promise<AntigravityRunResult> {
    if (signal?.aborted) return Promise.reject(cancelledError());

    let workspaceDir: string;
    try {
      workspaceDir = (this.options.createWorkspace ?? createAntigravityWorkspace)();
    } catch (error) {
      return Promise.reject(error);
    }

    const cleanup = () => {
      if (this.options.cleanupWorkspace) {
        this.options.cleanupWorkspace(workspaceDir);
        return;
      }
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        // Best effort after the process has exited. Startup reconciliation can
        // safely ignore an old empty conclave-agy-* directory if the OS refuses.
      }
    };

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(
          this.options.command ?? "agy",
          [...(this.options.prefixArgs ?? []), ...args],
          {
            cwd: workspaceDir,
            env: buildAntigravityChildEnv(),
            stdio: ["pipe", "pipe", "pipe"],
            detached: process.platform !== "win32",
          },
        );
        child.stdin.on("error", () => {});
        child.stdin.end(stdinText ?? "");
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const removeLifecycleListeners = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };

      const stopChild = () => {
        terminateProcess(child, "SIGTERM");
        if (child.exitCode !== null || killTimer) return;
        // Keep this timer referenced: teardown must finish even when the caller
        // has already rejected or the server is otherwise idle.
        killTimer = setTimeout(() => terminateProcess(child, "SIGKILL"), 1_000);
      };

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        removeLifecycleListeners();
        stopChild();
        // Do not remove the child's cwd while agy/the sandbox can still be using
        // it. The close handler owns workspace cleanup after process exit.
        reject(error);
      };

      const onAbort = () => finishReject(cancelledError());
      signal?.addEventListener("abort", onAbort, { once: true });

      timeout = setTimeout(() => {
        finishReject(new Error("Antigravity CLI timed out"));
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
      child.stderr.on("data", chunk => { stderr += String(chunk); });

      child.once("error", error => {
        const neverStarted = !child.pid;
        finishReject(error);
        if (neverStarted) cleanup();
      });

      child.once("close", code => {
        if (killTimer) clearTimeout(killTimer);
        killTimer = undefined;
        cleanup();
        if (settled) return;
        settled = true;
        removeLifecycleListeners();
        if (onStdoutLine && lineBuffer) onStdoutLine(lineBuffer);
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
  }
}
