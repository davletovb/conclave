import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

export type SeatlineEvent = {
  type: string;
  text?: string;
  reason?: string;
  status?: {
    availability: string;
    authentication: string;
    sign_in?: string;
    models: Array<{ id: string; label: string }>;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
};
type Pending = { emit: (event: SeatlineEvent) => void; resolve: () => void; reject: (error: Error) => void; dispose: () => void };
const MAX_FRAME = 1024 * 1024;

/** One app connection to the shared installation; no provider processes here. */
export class SeatlineClient {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private pending = new Map<string, Pending>();

  private connect() {
    if (this.ready) return this.ready;
    const child = spawn(process.env.SEATLINE_COMPANION_BIN ?? "seatline-companion", ["connect", "conclave"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.child = child;
    let bytes = Buffer.alloc(0);
    this.ready = new Promise<void>((resolve, reject) => {
      let connected = false;
      const timer = setTimeout(() => { reject(new Error("Seatline companion did not connect")); child.kill(); }, 10_000);
      const failed = (error: Error) => {
        clearTimeout(timer);
        if (!connected) reject(error);
        for (const item of this.pending.values()) { item.dispose(); item.reject(error); }
        this.pending.clear();
        if (this.child === child) { this.child = undefined; this.ready = undefined; }
      };
      child.once("error", failed);
      child.once("exit", () => failed(new Error("Seatline companion disconnected")));
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes = Buffer.concat([bytes, chunk]);
        while (bytes.length >= 4) {
          const length = bytes.readUInt32LE(0);
          if (!length || length > MAX_FRAME) { failed(new Error("Invalid Seatline frame")); child.kill(); return; }
          if (bytes.length < length + 4) return;
          let value: { type?: string; version?: number; id?: string; event?: SeatlineEvent };
          try { value = JSON.parse(bytes.subarray(4, length + 4).toString("utf8")); }
          catch { failed(new Error("Invalid Seatline response")); child.kill(); return; }
          bytes = bytes.subarray(length + 4);
          if (value.type === "ready") {
            if (value.version !== 1) { failed(new Error("Unsupported Seatline protocol")); child.kill(); return; }
            connected = true; clearTimeout(timer); resolve(); continue;
          }
          const item = value.id ? this.pending.get(value.id) : undefined;
          if (!item || !value.event) continue;
          const event = value.event;
          if (["completed", "failed", "stopped"].includes(event.type)) {
            this.pending.delete(value.id!); item.dispose();
            if (event.type === "completed") item.resolve();
            else item.reject(new Error(event.type === "stopped" ? "Run cancelled" : event.reason ?? "Seatline provider failed"));
          } else {
            try { item.emit(event); }
            catch (error) {
              this.write({ id: randomUUID(), method: "cancel", target: value.id });
              this.pending.delete(value.id!); item.dispose();
              item.reject(error instanceof Error ? error : new Error("Seatline event rejected"));
            }
          }
        }
      });
    });
    return this.ready;
  }

  private write(value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > MAX_FRAME) throw new Error("Seatline request is too large");
    const frame = Buffer.alloc(bytes.length + 4);
    frame.writeUInt32LE(bytes.length, 0); bytes.copy(frame, 4);
    if (!this.child || this.child.stdin.destroyed) throw new Error("Seatline companion is unavailable");
    if (this.child.stdin.writableLength > 2 * MAX_FRAME) throw new Error("Seatline request queue is full");
    this.child.stdin.write(frame);
  }

  async request(provider: string, method: string, params: unknown, emit: (event: SeatlineEvent) => void, signal?: AbortSignal) {
    await this.connect();
    if (signal?.aborted) throw new Error("Run cancelled");
    if (this.pending.size >= 32) throw new Error("Seatline request queue is full");
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const cancel = () => {
        try { this.write({ id: randomUUID(), method: "cancel", target: id }); } catch { /* connection already closed */ }
      };
      const timeout = setTimeout(() => { cancel(); this.pending.delete(id); dispose(); reject(new Error("Seatline request timed out")); }, 16 * 60_000);
      const dispose = () => { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); };
      this.pending.set(id, { emit, resolve, reject, dispose });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.write({ id, provider, method, params }); }
      catch (error) { this.pending.delete(id); dispose(); reject(error); }
    });
  }

  close() { this.child?.stdin.end(); this.child?.kill(); }
}
