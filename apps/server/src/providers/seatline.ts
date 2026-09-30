import type { ModelRef, ProviderAdapter, ProviderEventSink, ProviderId, ProviderLimitSnapshot, ProviderRequest, ProviderResponse, ProviderStatus } from "@conclave/core";
import { SeatlineClient, type SeatlineEvent } from "../seatline-client.js";

export class SeatlineProvider implements ProviderAdapter {
  constructor(readonly id: Exclude<ProviderId, "mock">, readonly label: string,
    private readonly provider: string, private readonly client: SeatlineClient) {}

  private acceptedSignIn(mode?: string) { return mode === "subscription" || (this.id === "google" && mode === "cloud"); }

  private async state() {
    let state: SeatlineEvent["status"];
    await this.client.request(this.provider, "status", null, event => { if (event.type === "status") state = event.status; });
    if (!state) throw new Error("Seatline did not return provider status");
    return state;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const state = await this.state();
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
    const state = await this.state();
    if (state.authentication !== "authenticated" || !this.acceptedSignIn(state.sign_in)) return [];
    return state.models.map(model => ({ provider: this.id, model: model.id, label: model.label, source: "subscription" }));
  }

  async limits(): Promise<ProviderLimitSnapshot> {
    return { provider: this.id, available: false, message: "The Seatline CLI adapter does not expose a structured subscription-limit snapshot." };
  }

  async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    const startedAt = Date.now();
    const state = await this.state();
    if (request.signal?.aborted) throw new Error("Run cancelled");
    if (state.authentication !== "authenticated" || !this.acceptedSignIn(state.sign_in)) {
      throw new Error("A verified subscription sign-in is required. Sign in to your provider CLI.");
    }
    let content = "";
    await this.client.request(this.provider, "send", {
      system: [request.system, ...request.messages.filter(m => m.role === "system").map(m => m.content)].filter(Boolean).join("\n\n") || null,
      messages: request.messages.filter(m => m.role !== "system").map(m => ({ role: m.role, text: m.content })),
      model: request.model, tools: "none", session: "ephemeral", continuation: null, cleanup_group: null, check_sign_in: true,
    }, event => {
      if (event.type === "status" && !this.acceptedSignIn(event.status?.sign_in)) throw new Error("Provider sign-in changed; subscription account required");
      if (event.type === "delta" && event.text) { content += event.text; emit?.({ type: "text_delta", delta: event.text }); }
      if (event.type === "usage") emit?.({ type: "usage", inputTokens: event.usage?.input_tokens, outputTokens: event.usage?.output_tokens });
    }, request.signal);
    if (!content.trim()) throw new Error("Provider completed without a text response");
    return { provider: this.id, model: request.model, content, latencyMs: Date.now() - startedAt };
  }
}
