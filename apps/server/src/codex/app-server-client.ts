import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface CodexNotification {
  method: string;
  params?: Record<string, unknown>;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export interface CodexClientLike {
  request<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  onNotification(listener: (notification: CodexNotification) => void): () => void;
  close(): void;
}

export class CodexAppServerClient implements CodexClientLike {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Set<(notification: CodexNotification) => void>();
  private starting: Promise<void> | null = null;
  private initialized = false;
  private stderrTail = "";

  constructor(
    private readonly binary = process.env.CONCLAVE_CODEX_BIN ?? "codex",
    private readonly defaultTimeoutMs = Number(process.env.CONCLAVE_CODEX_RPC_TIMEOUT_MS ?? 15_000),
  ) {}

  async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    await this.ensureStarted();
    return this.rawRequest<T>(method, params, timeoutMs);
  }

  onNotification(listener: (notification: CodexNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.initialized = false;
    this.child?.kill();
    this.child = null;
    this.failPending(new Error("Codex app-server closed"));
  }

  private async ensureStarted() {
    if (this.child && this.initialized && !this.child.killed) return;
    if (!this.starting) {
      this.starting = this.startProcess().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private async startProcess() {
    const child = spawn(this.binary, ["app-server", "--stdio"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderrTail = "";

    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => this.handleLine(line));
    child.stderr.on("data", chunk => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4_000);
    });
    child.on("exit", (code, signal) => {
      const detail = this.stderrTail.trim();
      const suffix = detail ? `: ${detail}` : "";
      this.initialized = false;
      this.child = null;
      this.failPending(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})${suffix}`));
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", error => reject(new Error(`Could not start Codex CLI (${this.binary}): ${error.message}`)));
    });

    await this.rawRequest("initialize", {
      clientInfo: {
        name: "conclave",
        title: "Conclave",
        version: "0.2.0",
      },
      capabilities: {},
    }, 10_000);
    this.rawNotify("initialized", {});
    this.initialized = true;
  }

  private rawRequest<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("Codex app-server is not running"));

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });

      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private rawNotify(method: string, params: Record<string, unknown>) {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      const rpcError = message.error as { message?: string } | undefined;
      if (rpcError) {
        pending.reject(new Error(rpcError.message ?? "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      const notification: CodexNotification = {
        method: message.method,
        params: (message.params as Record<string, unknown> | undefined) ?? {},
      };
      for (const listener of this.listeners) listener(notification);
    }
  }

  private failPending(error: Error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
