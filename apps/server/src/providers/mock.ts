import type {
  ModelRef,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
} from "@conclave/core";

const modelCatalog: ModelRef[] = [
  { provider: "mock", model: "mock-gpt", label: "GPT (mock)", source: "mock", isDefault: true },
  { provider: "mock", model: "mock-claude", label: "Claude (mock)", source: "mock" },
  { provider: "mock", model: "mock-grok", label: "Grok (mock)", source: "mock" },
];

export class MockProvider implements ProviderAdapter {
  readonly id = "mock" as const;
  readonly label = "Mock provider";

  async listModels() {
    return modelCatalog;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const started = Date.now();
    const latest = request.messages.at(-1)?.content ?? "";
    const persona = request.model.includes("claude")
      ? "careful analyst"
      : request.model.includes("grok")
        ? "contrarian reviewer"
        : "systems thinker";

    return {
      provider: this.id,
      model: request.model,
      latencyMs: Date.now() - started,
      content: `[${persona}] ${latest.slice(0, 420)}${latest.length > 420 ? "…" : ""}`,
    };
  }
}
