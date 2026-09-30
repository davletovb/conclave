import { describe, expect, it } from "vitest";
import { SeatlineClient, type SeatlineEvent } from "../seatline-client.js";
import { SeatlineProvider } from "./seatline.js";

class Client extends SeatlineClient {
  sends: unknown[] = [];
  mode = "subscription";
  override async request(_provider: string, method: string, params: unknown, emit: (event: SeatlineEvent) => void, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("Run cancelled");
    if (method === "status") { emit({ type: "status", status: { availability: "available", authentication: "authenticated", sign_in: this.mode, models: [{ id: "test", label: "Test" }] } }); return; }
    this.sends.push(params);
    emit({ type: "delta", text: "Hello " }); emit({ type: "delta", text: "world" });
    emit({ type: "usage", usage: { input_tokens: 2, output_tokens: 3 } });
  }
}
describe("shared Seatline provider policy", () => {
  it("refuses API billing and unknown accounts before scheduling a turn", async () => {
    const client = new Client(); const provider = new SeatlineProvider("openai", "Codex", "codex", client);
    for (const mode of ["api_key", "unknown", "cloud"]) {
      client.mode = mode;
      await expect(provider.generate({ model: "test", messages: [{ role: "user", content: "hello" }] })).rejects.toThrow("subscription");
    }
    expect(client.sends).toEqual([]);
  });
  it("keeps untrusted orchestration text tool-free and reconstructs the streamed answer", async () => {
    const client = new Client(); const provider = new SeatlineProvider("anthropic", "Claude", "claude", client);
    const events: unknown[] = [];
    const response = await provider.generate({ model: "test", system: "App instructions", messages: [{ role: "system", content: "Prior context" }, { role: "user", content: "hello" }] }, event => events.push(event));
    expect(response.content).toBe("Hello world");
    expect(client.sends[0]).toMatchObject({ tools: "none", session: "ephemeral", continuation: null, check_sign_in: true, system: "App instructions\n\nPrior context", messages: [{ role: "user", text: "hello" }] });
    expect(events).toContainEqual({ type: "usage", inputTokens: 2, outputTokens: 3 });
  });
  it("accepts Google cloud-account authentication and cancels without a turn", async () => {
    const client = new Client(); client.mode = "cloud";
    const provider = new SeatlineProvider("google", "Gemini", "gemini", client);
    expect((await provider.status()).connected).toBe(true);
    const control = new AbortController(); control.abort();
    await expect(provider.generate({ model: "test", messages: [{ role: "user", content: "hello" }], signal: control.signal })).rejects.toThrow("cancelled");
    expect(client.sends).toEqual([]);
  });
});
