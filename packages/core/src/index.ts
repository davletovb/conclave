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
  /** Server-injected prior conversation context. Clients normally omit this. */
  history?: ChatMessage[];
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

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
  lastRunId?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  messageCount: number;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "interrupted";

export interface StoredRun {
  id: string;
  conversationId: string;
  userMessageId: string;
  status: RunStatus;
  attempt: number;
  request: OrchestrationRequest;
  createdAt: string;
  updatedAt: string;
  result?: OrchestrationResult;
  error?: string;
}

export interface RunEventRecord {
  seq: number;
  attempt: number;
  at: string;
  event: OrchestrationStreamEvent;
}

export interface StartRunRequest {
  conversationId?: string;
  request: OrchestrationRequest;
}

export interface StartRunResponse {
  conversationId: string;
  runId: string;
  status: RunStatus;
  attempt: number;
}

export function makeStepId(prefix: string, index: number) {
  return `${prefix}-${index + 1}`;
}
