import type { ModelRef, ProviderAdapter, ProviderEventSink, ProviderId, ProviderLimitSnapshot, ProviderRequest, ProviderResponse, ProviderStatus } from "@conclave/core";
import { SeatlineClient, type SeatlineEvent } from "./companion";

const DEFAULT_MODEL = "seatline:default";
// The UI asks for status often and in bursts; a run checks the provider once per step. Both can reuse a
// recent answer instead of starting a provider process each time.
const STATE_REUSE_MS = 2_000;
const PREFLIGHT_REUSE_MS = 30_000;
/** An age no answer can satisfy: always ask the companion. */
const FRESH = -1;

export class SeatlineProvider implements ProviderAdapter {
  constructor(readonly id: Exclude<ProviderId, "mock">, readonly label: string,
    private readonly provider: string, private readonly client: SeatlineClient) {}

  private usable(state: NonNullable<SeatlineEvent["status"]>) { return state.authentication === "authenticated" && this.acceptedSignIn(state.sign_in); }

  private acceptedSignIn(mode?: string) { return mode === "subscription" || (this.id === "google" && mode === "cloud"); }

  private async fetchState() {
    let state: SeatlineEvent["status"];
    await this.client.request(this.provider, "status", null, event => { if (event.type === "status") state = event.status; });
    if (!state) throw new Error("Seatline did not return provider status");
    return state;
  }

  private latest: { at: number; promise: Promise<NonNullable<SeatlineEvent["status"]>> } | undefined;

  /**
   * The provider's state, reusing an answer no older than `maxAgeMs`, including one still on its way, so
   * concurrent callers share a single status request. Every status request runs a provider process and
   * takes one of the companion's few running slots, so asking again for each step of a run is costly.
   */
  private state(maxAgeMs: number) {
    const now = Date.now();
    if (this.latest && now - this.latest.at <= maxAgeMs) return this.latest.promise;
    const entry = { at: now, promise: this.fetchState() };
    this.latest = entry;
    entry.promise.catch(() => { if (this.latest === entry) this.latest = undefined; });
    return entry.promise;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const state = await this.state(STATE_REUSE_MS);
      return { id: this.id, label: this.label, available: state.availability === "available",
        connected: state.authentication === "authenticated" && this.acceptedSignIn(state.sign_in),
        authMode: state.sign_in,
        message: this.acceptedSignIn(state.sign_in) ? undefined : "Sign in to the provider CLI with your subscription account." };
    } catch (error) {
      return { id: this.id, label: this.label, available: false, connected: false,
        message: error instanceof Error ? error.message : "Seatline unavailable" };
    }
  }

  async listModels(): Promise<ModelRef[]> {
    const state = await this.state(STATE_REUSE_MS);
    if (state.authentication !== "authenticated" || !this.acceptedSignIn(state.sign_in)) return [];
    return [{ provider: this.id, model: DEFAULT_MODEL, label: `${this.label} (provider default)`, source: "subscription" as const, isDefault: true },
      ...state.models.map(model => ({ provider: this.id, model: model.id, label: model.label, source: "subscription" as const }))];
  }

  async limits(): Promise<ProviderLimitSnapshot> {
    return { provider: this.id, available: false, message: "The Seatline CLI adapter does not expose a structured subscription-limit snapshot." };
  }

  async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    const startedAt = Date.now();
    // A recent answer is enough to start a step. If it says the provider is not usable, ask again: the
    // user may have signed in since.
    let state = await this.state(PREFLIGHT_REUSE_MS);
    if (!this.usable(state)) state = await this.state(FRESH);
    if (request.signal?.aborted) throw new Error("Run cancelled");
    if (!this.usable(state)) {
      throw new Error("A verified subscription sign-in is required. Sign in to your provider CLI.");
    }
    let content = "";
    await this.client.request(this.provider, "send", {
      system: [request.system, ...request.messages.filter(m => m.role === "system").map(m => m.content)].filter(Boolean).join("\n\n") || null,
      messages: request.messages.filter(m => m.role !== "system").map(m => ({ role: m.role, text: m.content })),
      model: request.model === DEFAULT_MODEL ? null : request.model, tools: "none", session: "ephemeral", continuation: null, cleanup_group: null, check_sign_in: true,
    }, event => {
      // Waiting for one of the companion's slots: tell the run, which counts it as activity, not a stall.
      if (event.type === "queued") emit?.({ type: "status", message: "Waiting for your Seatline companion to finish other requests" });
      if (event.type === "status" && !this.acceptedSignIn(event.status?.sign_in)) throw new Error("Provider sign-in changed; subscription account required");
      if (event.type === "delta" && event.text) { content += event.text; emit?.({ type: "text_delta", delta: event.text }); }
      if (event.type === "usage") emit?.({ type: "usage", inputTokens: event.usage?.input_tokens, outputTokens: event.usage?.output_tokens });
    }, request.signal);
    if (!content.trim()) throw new Error("Provider completed without a text response");
    return { provider: this.id, model: request.model, content, latencyMs: Date.now() - startedAt };
  }
}
