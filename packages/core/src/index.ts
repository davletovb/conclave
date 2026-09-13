export type ProviderId = "openai" | "anthropic" | "xai" | "mock";

export type OrchestrationMode =
  | "single"
  | "compare"
  | "panel"
  | "debate"
  | "critic-revise"
  | "consensus"
  | "judge"
  | "red-team"
  | "router"
  | "research-council"
  | "planner-executor"
  | "custom";

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

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface ProviderLimitSnapshot {
  provider: ProviderId;
  available: boolean;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  reachedType?: string;
  message?: string;
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
  signal?: AbortSignal;
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
  limits?(): Promise<ProviderLimitSnapshot>;
}

export interface RunBudget {
  /** Hard cap on model calls for one orchestration attempt. */
  maxCalls?: number;
  /** Hard cap on Debate critique rounds. Other modes have fixed stage counts. */
  maxRounds?: number;
}

export type WorkflowModelSelector =
  | { type: "participant"; index: number }
  | { type: "synthesizer" };

export interface WorkflowNode {
  /** Stable, unique node ID used by dependencies and inspection. */
  id: string;
  kind: OrchestrationStepKind;
  model: WorkflowModelSelector;
  /**
   * Supports {{prompt}}, {{dependencies}}, and {{dep.<nodeId>}} placeholders.
   * Only declared dependencies are available to the node.
   */
  promptTemplate: string;
  dependsOn?: string[];
}

export interface WorkflowGraph {
  id?: string;
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  outputNodeId: string;
}

export interface WorkflowPreset {
  id: string;
  name: string;
  description: string;
  graph: WorkflowGraph;
}

export interface RunUsage {
  callsStarted: number;
  callsCompleted: number;
  inputTokens: number;
  outputTokens: number;
  tokenReports: number;
}

export interface RateLimitNotice {
  provider: ProviderId;
  model: string;
  stepId: string;
  message: string;
  at: string;
}

export interface StepFailure {
  stepId: string;
  kind: OrchestrationStepKind;
  model: ModelRef;
  message: string;
  retryable: boolean;
  attempts: number;
}

export interface OrchestrationRequest {
  mode: OrchestrationMode;
  prompt: string;
  participants: ModelRef[];
  synthesizer?: ModelRef;
  /** Required when mode is custom. */
  workflow?: WorkflowGraph;
  /** @deprecated Prefer budget.maxRounds. Retained for compatibility. */
  maxRounds?: number;
  budget?: RunBudget;
  /** Server-injected prior conversation context. Clients normally omit this. */
  history?: ChatMessage[];
}

export type OrchestrationStepKind =
  | "answer"
  | "critique"
  | "revision"
  | "synthesis"
  | "judgment"
  | "route"
  | "research"
  | "plan"
  | "execution"
  | "review";

export interface OrchestrationStep {
  id: string;
  kind: OrchestrationStepKind;
  model: ModelRef;
  content: string;
  dependsOn?: string[];
}

export interface OrchestrationResult {
  mode: OrchestrationMode;
  steps: OrchestrationStep[];
  final: string;
  degraded?: boolean;
  failures?: StepFailure[];
}

export type OrchestrationStreamEvent =
  | { type: "run_started"; runId: string; mode: OrchestrationMode }
  | { type: "run_usage"; runId: string; usage: RunUsage; budget?: RunBudget }
  | { type: "run_cancelled"; runId: string; message: string }
  | { type: "rate_limit"; runId: string; notice: RateLimitNotice }
  | { type: "step_started"; runId: string; stepId: string; kind: OrchestrationStepKind; model: ModelRef; dependsOn?: string[] }
  | { type: "step_retrying"; runId: string; stepId: string; attempt: number; message: string }
  | { type: "step_failed"; runId: string; failure: StepFailure }
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
  /** Matching excerpt. Only present when the listing was filtered by a search query. */
  snippet?: string;
}

export type ConversationExportFormat = "markdown" | "json";

export interface ConversationExportRun {
  id: string;
  attempt: number;
  status: RunStatus;
  mode: OrchestrationMode;
  participants: ModelRef[];
  synthesizer?: ModelRef;
  workflow?: WorkflowGraph;
  usage: RunUsage;
  createdAt: string;
  updatedAt: string;
  steps: OrchestrationStep[];
  error?: string;
}

export interface ConversationExport {
  version: 1;
  exportedAt: string;
  conversation: Conversation;
  runs: ConversationExportRun[];
}

export type RunStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "interrupted" | "cancelled";

export interface StoredRun {
  id: string;
  conversationId: string;
  userMessageId: string;
  status: RunStatus;
  attempt: number;
  request: OrchestrationRequest;
  usage: RunUsage;
  createdAt: string;
  updatedAt: string;
  result?: OrchestrationResult;
  error?: string;
  rateLimit?: RateLimitNotice;
  cancelRequestedAt?: string;
}

export interface RunEventRecord {
  seq: number;
  attempt: number;
  at: string;
  event: OrchestrationStreamEvent;
}

export interface RunStepInspection {
  id: string;
  kind?: OrchestrationStepKind;
  model?: ModelRef;
  dependsOn: string[];
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  attempts?: number;
  error?: string;
}

export interface RunAttemptInspection {
  attempt: number;
  status: RunStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  eventCount: number;
  usage: RunUsage;
  steps: RunStepInspection[];
  rateLimit?: RateLimitNotice;
  error?: string;
}

export interface RunInspection {
  run: StoredRun;
  attempts: RunAttemptInspection[];
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

export function emptyRunUsage(): RunUsage {
  return {
    callsStarted: 0,
    callsCompleted: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokenReports: 0,
  };
}

export function makeStepId(prefix: string, index: number) {
  return `${prefix}-${index + 1}`;
}
