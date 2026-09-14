import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
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
  ): Promise<AntigravityRunResult>;
}

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
] as const;

export function buildAntigravityChildEnv(source: NodeJS.ProcessEnv = process.env) {
  const env = { ...source };

  // Antigravity can be configured to use direct Gemini API credentials. Conclave's
  // Google adapter is subscription-only, so shadow (rather than delete) those
  // variables: an inherited shell/profile or dotenv loader cannot repopulate them.
  for (const name of BLOCKED_BILLING_ENV) env[name] = "";

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

function createPrivateWorkspace() {
  const workspaceDir = mkdtempSync(join(tmpdir(), "conclave-agy-"));
  try {
    chmodSync(workspaceDir, 0o700);
    return workspaceDir;
  } catch (error) {
    rmSync(workspaceDir, { recursive: true, force: true });
    throw error;
  }
}

export class NativeAntigravityCliRunner implements AntigravityCliRunner {
  run(
    args: string[],
    timeoutMs = 180_000,
    onStdoutLine?: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<AntigravityRunResult> {
    if (signal?.aborted) return Promise.reject(cancelledError());

    let workspaceDir: string;
    try {
      workspaceDir = createPrivateWorkspace();
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn("agy", args, {
          cwd: workspaceDir,
          env: buildAntigravityChildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        rmSync(workspaceDir, { recursive: true, force: true });
        reject(error);
        return;
      }

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const cleanupWorkspace = () => {
        try {
          rmSync(workspaceDir, { recursive: true, force: true });
        } catch {
          // Best effort on Windows while a just-terminated child still owns cwd.
        }
      };

      const removeLifecycleListeners = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };

      const stopChild = () => {
        terminateProcess(child, "SIGTERM");
        if (child.exitCode !== null || killTimer) return;
        killTimer = setTimeout(() => terminateProcess(child, "SIGKILL"), 1_000);
        killTimer.unref();
      };

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        removeLifecycleListeners();
        stopChild();
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

      child.once("error", error => finishReject(error));

      child.once("close", code => {
        if (killTimer) clearTimeout(killTimer);
        killTimer = undefined;
        cleanupWorkspace();
        if (settled) return;
        settled = true;
        removeLifecycleListeners();
        if (onStdoutLine && lineBuffer) onStdoutLine(lineBuffer);
        resolve({ stdout, stderr, code: code ?? 1 });
      });
    });
  }
}
