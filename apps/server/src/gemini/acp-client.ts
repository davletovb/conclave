import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

type JsonRpcId = number | string;

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type GeminiAcpNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export interface GeminiAcpClientLike {
  readonly workspaceDir: string;
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  onNotification(listener: (notification: GeminiAcpNotification) => void): () => void;
  close(): void;
}

export const GEMINI_ACP_ARGS = ["--acp"] as const;

const DENY_ALL_TOOLS_POLICY = `[[rule]]
toolName = "*"
decision = "deny"
priority = 999
denyMessage = "Conclave runs Gemini in text-only mode."
`;

const ISOLATED_WORKSPACE_SETTINGS = JSON.stringify({
  security: { auth: { selectedType: "oauth-personal" } },
  hooksConfig: { enabled: false },
  skills: { enabled: false },
  ide: { enabled: false },
}, null, 2);

export function buildGeminiAcpArgs(model: string | undefined, policyPath: string, mcpSentinel: string) {
  const args: string[] = [
    ...GEMINI_ACP_ARGS,
    // User extensions can add tools, hooks and MCP servers. Conclave is a
    // text-only model surface, so do not load any extension at all.
    "--extensions", "none",
    // Gemini's ACP session merges its mcpServers with user-configured MCPs.
    // A non-existent per-process allowlist entry makes every configured server
    // fail the CLI's allowlist check before a client is connected/spawned.
    "--allowed-mcp-server-names", mcpSentinel,
    // Deny every built-in and MCP tool at the policy-engine layer. A global
    // deny rule also removes those tools from the model's context entirely.
    "--admin-policy", policyPath,
  ];
  if (model) args.push("--model", model);
  return args;
}

function permissionDenialResult(params?: Record<string, unknown>) {
  const options = Array.isArray(params?.options) ? params.options : [];
  const records = options.filter(
    (option): option is Record<string, unknown> => Boolean(option) && typeof option === "object",
  );
  const reject = records.find(option => option.kind === "reject_once")
    ?? records.find(option => option.kind === "reject_always");

  if (reject && typeof reject.optionId === "string") {
    return {
      outcome: {
        outcome: "selected",
        optionId: reject.optionId,
      },
    };
  }

  return { outcome: { outcome: "cancelled" } };
}

function subscriptionOnlyEnv() {
  const env = { ...process.env };

  // Gemini CLI supports several credential routes. Conclave deliberately uses
  // only the Google-account OAuth already established by the official CLI.
  for (const name of [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
    "GOOGLE_CLOUD_ACCESS_TOKEN",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_PROJECT_ID",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "CLOUD_ML_PROJECT_ID",
    "GOOGLE_GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GEMINI_SANDBOX",
  ]) {
    delete env[name];
  }

  // OAuth fallback must never open a browser from the Conclave server. ACP is
  // considered interactive by Gemini CLI, so stale credentials may still try
  // terminal user-code auth; non-JSON stdout below treats that as protocol
  // escape and fails closed.
  env.NO_BROWSER = "true";
  env.GEMINI_CLI_SURFACE = "conclave";
  env.GEMINI_CLI_TRUST_WORKSPACE = "true";

  return env;
}

export class GeminiAcpClient implements GeminiAcpClientLike {
  readonly workspaceDir: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lineReader: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(notification: GeminiAcpNotification) => void>();
  private nextId = 1;
  private stderrTail = "";
  private terminalError: Error | null = null;
  private closed = false;
  private cleaned = false;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(model?: string) {
    this.workspaceDir = mkdtempSync(join(tmpdir(), "conclave-gemini-"));
    chmodSync(this.workspaceDir, 0o700);

    const geminiDir = join(this.workspaceDir, ".gemini");
    mkdirSync(geminiDir, { mode: 0o700 });
    writeFileSync(join(geminiDir, "settings.json"), ISOLATED_WORKSPACE_SETTINGS, {
      encoding: "utf8",
      mode: 0o600,
    });

    const policyPath = join(this.workspaceDir, "deny-tools.toml");
    writeFileSync(policyPath, DENY_ALL_TOOLS_POLICY, { encoding: "utf8", mode: 0o600 });
    const mcpSentinel = `__conclave_no_mcp_${randomUUID()}__`;
    const args = buildGeminiAcpArgs(model, policyPath, mcpSentinel);

    this.child = spawn("gemini", args, {
      env: subscriptionOnlyEnv(),
      cwd: this.workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.lineReader = readline.createInterface({ input: this.child.stdout });

    this.lineReader.on("line", line => this.handleLine(line));
    this.child.stderr.on("data", chunk => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8000);
    });
    this.child.stdin.on("error", error => {
      // An early process exit commonly surfaces as EPIPE on stdin. Without an
      // error listener Node treats this as unhandled and crashes the server.
      if (this.closed) return;
      this.terminalError = error;
      this.failAll(error);
    });

    this.child.once("error", error => {
      this.terminalError = error;
      this.failAll(error);
    });
    this.child.once("close", code => {
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = null;
      this.cleanupWorkspace();
      if (this.closed) return;
      const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : "";
      const error = new Error(`Gemini ACP exited with code ${code ?? "unknown"}${suffix}`);
      this.terminalError = error;
      this.failAll(error);
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closed) return Promise.reject(new Error("Gemini ACP client is closed"));
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });

      this.writeMessage({ jsonrpc: "2.0", id, method, params }, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closed) return Promise.reject(new Error("Gemini ACP client is closed"));
    return new Promise<void>((resolve, reject) => {
      this.writeMessage({ jsonrpc: "2.0", method, params }, error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  onNotification(listener: (notification: GeminiAcpNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.lineReader.close();
    this.child.kill("SIGTERM");
    this.failAll(new Error("Gemini ACP client closed"));
    if (this.child.exitCode !== null) {
      this.cleanupWorkspace();
      return;
    }

    this.killTimer = setTimeout(() => {
      if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGKILL");
    }, 1_000);
    this.killTimer.unref();
  }

  private handleLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // stdout is the ACP JSON-RPC transport. Human auth prompts, TUI control
      // sequences, or other prose here mean the CLI escaped the protocol. Kill
      // it rather than letting server-side OAuth become interactive.
      const error = new Error(
        "Gemini ACP emitted non-JSON output. Interactive authentication is disabled in Conclave; run `gemini` in a terminal and sign in with Google first.",
      );
      this.terminalError = error;
      this.failAll(error);
      this.close();
      return;
    }

    if (message.method) {
      if (message.id === undefined) {
        const notification = { method: message.method, params: message.params };
        for (const listener of this.listeners) listener(notification);
        return;
      }

      // Conclave is a text-only reasoning surface. The deny-all policy should
      // prevent permission requests, but reject one defensively if upstream
      // behavior changes or a centrally-managed policy supersedes ours.
      if (message.method === "session/request_permission") {
        this.writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: permissionDenialResult(message.params),
        });
      } else {
        this.writeMessage({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unsupported ACP client method: ${message.method}` },
        });
      }
      return;
    }

    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  private writeMessage(
    message: Record<string, unknown>,
    callback?: (error?: Error | null) => void,
  ) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, error => callback?.(error));
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private cleanupWorkspace() {
    if (this.cleaned) return;
    this.cleaned = true;
    try {
      rmSync(this.workspaceDir, { recursive: true, force: true });
    } catch {
      // Best effort on Windows if the child still holds its cwd briefly. The OS
      // temp directory will eventually clean up these non-sensitive files.
    }
  }
}
