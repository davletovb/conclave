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

export type ProviderStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "status"; message: string }
  | { type: "tool_call"; id: string; name: string; input?: unknown }
  | { type: "tool_result"; id: string; output?: unknown; isError?: boolean }
  | { type: "citation"; url?: string; title?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number };

export type ProviderEventSink = (event: ProviderStreamEvent) => void;

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  listModels(): Promise<ModelRef[]>;
  generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse>;
}

export interface OrchestrationRequest {
  mode: OrchestrationMode;
  prompt: string;
  participants: ModelRef[];
  synthesizer?: ModelRef;
  maxRounds?: number;
}

export type OrchestrationStepKind = "answer" | "critique" | "revision" | "synthesis";

export interface OrchestrationStep {
  id: string;
  kind: OrchestrationStepKind;
  model: ModelRef;
  content: string;
}

export interface OrchestrationResult {
  mode: OrchestrationMode;
  steps: OrchestrationStep[];
  final: string;
}

export type OrchestrationStreamEvent =
  | { type: "run_started"; runId: string; mode: OrchestrationMode }
  | { type: "step_started"; runId: string; stepId: string; kind: OrchestrationStepKind; model: ModelRef }
  | { type: "text_delta"; runId: string; stepId: string; delta: string }
  | { type: "status"; runId: string; stepId: string; message: string }
  | { type: "tool_call"; runId: string; stepId: string; id: string; name: string; input?: unknown }
  | { type: "tool_result"; runId: string; stepId: string; id: string; output?: unknown; isError?: boolean }
  | { type: "citation"; runId: string; stepId: string; url?: string; title?: string }
  | { type: "usage"; runId: string; stepId: string; inputTokens?: number; outputTokens?: number }
  | { type: "step_completed"; runId: string; step: OrchestrationStep }
  | { type: "run_completed"; runId: string; result: OrchestrationResult }
  | { type: "error"; runId: string; message: string; stepId?: string };

export type OrchestrationEventSink = (event: OrchestrationStreamEvent) => void;

export function makeStepId(prefix: string, index: number) {
  return `${prefix}-${index + 1}`;
}
