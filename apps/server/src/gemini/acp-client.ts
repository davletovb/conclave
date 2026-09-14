import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onNotification(listener: (notification: GeminiAcpNotification) => void): () => void;
  close(): void;
}

export const GEMINI_ACP_ARGS = ["--acp"] as const;
export const GEMINI_OAUTH_CREDENTIAL_PATH = join(homedir(), ".gemini", "oauth_creds.json");

export function hasCachedGeminiOAuth() {
  // Presence only: Conclave never reads, copies, parses, or refreshes Google's
  // OAuth material. The official Gemini CLI owns the credentials end to end.
  return existsSync(GEMINI_OAUTH_CREDENTIAL_PATH);
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

  // Gemini CLI supports several credential routes. Conclave is deliberately
  // subscription/OAuth-only, so remove API-key, ADC and Vertex selectors from
  // the child process before asking ACP to authenticate with oauth-personal.
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  delete env.GOOGLE_GENAI_USE_VERTEXAI;

  // Identify the integration honestly to Gemini CLI and avoid a workspace
  // trust prompt in our isolated temp working directory.
  env.GEMINI_CLI_SURFACE = "conclave";
  env.GEMINI_CLI_TRUST_WORKSPACE = "true";

  return env;
}

export class GeminiAcpClient implements GeminiAcpClientLike {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lineReader: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(notification: GeminiAcpNotification) => void>();
  private nextId = 1;
  private stderrTail = "";
  private terminalError: Error | null = null;
  private closed = false;

  constructor(model?: string) {
    const args: string[] = [...GEMINI_ACP_ARGS];
    if (model) args.push("--model", model);

    this.child = spawn("gemini", args, {
      env: subscriptionOnlyEnv(),
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.lineReader = readline.createInterface({ input: this.child.stdout });

    this.lineReader.on("line", line => this.handleLine(line));
    this.child.stderr.on("data", chunk => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8000);
    });

    this.child.once("error", error => {
      this.terminalError = error;
      this.failAll(error);
    });
    this.child.once("close", code => {
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
  }

  private handleLine(line: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.method) {
      if (message.id === undefined) {
        const notification = { method: message.method, params: message.params };
        for (const listener of this.listeners) listener(notification);
        return;
      }

      // Conclave is a text-only reasoning surface. It advertises no filesystem
      // or terminal capability and rejects any permission request defensively.
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
}
