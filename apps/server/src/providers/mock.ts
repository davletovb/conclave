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
  { provider: "mock", model: "mock-gemini", label: "Gemini (mock)", source: "mock" },
];

export class MockProvider implements ProviderAdapter {
  readonly id = "mock" as const;
  readonly label = "Mock provider";

  async listModels() {
    return modelCatalog;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.signal?.aborted) {
      const error = new Error("Mock request cancelled");
      error.name = "AbortError";
      throw error;
    }

    const started = Date.now();
    const latest = request.messages.at(-1)?.content ?? "";
    const persona = request.model.includes("claude")
      ? "careful analyst"
      : request.model.includes("grok")
        ? "contrarian reviewer"
        : request.model.includes("gemini")
          ? "multimodal researcher"
          : "systems thinker";

    return {
      provider: this.id,
      model: request.model,
      latencyMs: Date.now() - started,
      content: `[${persona}] ${latest.slice(0, 420)}${latest.length > 420 ? "…" : ""}`,
    };
  }
}
