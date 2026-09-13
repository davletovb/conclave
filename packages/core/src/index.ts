export type ProviderId = "openai" | "anthropic" | "xai" | "mock";

export type OrchestrationMode =
  | "single"
  | "compare"
  | "panel"
  | "debate"
  | "critic-revise";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ModelRef {
  provider: ProviderId;
  model: string;
  label: string;
  source?: "subscription" | "mock";
  isDefault?: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  available: boolean;
  connected: boolean;
  authMode?: string;
  planType?: string;
  message?: string;
}

export interface ProviderRequest {
  model: string;
  messages: ChatMessage[];
  system?: string;
}

export interface ProviderResponse {
  provider: ProviderId;
  model: string;
  content: string;
  latencyMs?: number;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  listModels(): Promise<ModelRef[]>;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface OrchestrationRequest {
  mode: OrchestrationMode;
  prompt: string;
  participants: ModelRef[];
  synthesizer?: ModelRef;
  maxRounds?: number;
}

export interface OrchestrationStep {
  id: string;
  kind: "answer" | "critique" | "revision" | "synthesis";
  model: ModelRef;
  content: string;
}

export interface OrchestrationResult {
  mode: OrchestrationMode;
  steps: OrchestrationStep[];
  final: string;
}

export function makeStepId(prefix: string, index: number) {
  return `${prefix}-${index + 1}`;
}
