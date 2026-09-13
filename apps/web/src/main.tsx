import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Conversation,
  ConversationSummary,
  ModelRef,
  OrchestrationMode,
  OrchestrationResult,
  OrchestrationStep,
  OrchestrationStreamEvent,
  ProviderId,
  ProviderLimitSnapshot,
  ProviderStatus,
  RateLimitNotice,
  RunEventRecord,
  RunInspection,
  RunUsage,
  StartRunResponse,
  StoredRun,
  WorkflowGraph,
  WorkflowPreset,
} from "@conclave/core";
import { Markdown } from "./markdown";
import { CouncilWork, RunConfigSummary, RunSetup } from "./reasoning-surface";
import "./styles.css";

const API = import.meta.env.VITE_CONCLAVE_API ?? "http://localhost:8787";
const modes: { id: OrchestrationMode; label: string; description: string }[] = [
  { id: "single", label: "Single", description: "One model, one answer" },
  { id: "compare", label: "Compare", description: "Independent answers side by side" },
  { id: "panel", label: "Panel", description: "Independent answers, then synthesis" },
  { id: "debate", label: "Debate", description: "Challenge positions, then judge" },
  { id: "critic-revise", label: "Critic → Revise", description: "Draft, critique, improve" },
  { id: "consensus", label: "Consensus", description: "Find agreement, then audit it" },
  { id: "judge", label: "Judge", description: "Generate candidates, adjudicate once" },
  { id: "red-team", label: "Red Team", description: "Attack a draft, then harden it" },
  { id: "router", label: "Router", description: "Choose one specialist for the task" },
  { id: "research-council", label: "Research Council", description: "Evidence, alternatives, risks, synthesis" },
  { id: "planner-executor", label: "Planner → Executors", description: "Plan, execute in parallel, review" },
  { id: "custom", label: "Custom Workflow", description: "Run a reusable or edited workflow graph" },
];

const workflowKinds = new Set([
  "answer",
  "critique",
  "revision",
  "synthesis",
  "judgment",
  "route",
  "research",
  "plan",
  "execution",
  "review",
]);

type Theme = "dark" | "light";

function initialTheme(): Theme {
  const saved = localStorage.getItem("conclave.theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function minimumParticipants(mode: OrchestrationMode) {
  return mode === "consensus" || mode === "judge" || mode === "router" || mode === "research-council" ? 2 : 1;
}

function requiredWorkflowParticipants(workflow?: WorkflowGraph) {
  if (!workflow) return 1;
  const indices = workflow.nodes
    .filter(node => node?.model?.type === "participant")
    .map(node => node.model.type === "participant" ? node.model.index : -1);
  return Math.max(1, ...indices.map(index => index + 1));
}

function plannedCalls(mode: OrchestrationMode, participantCount: number, rounds: number, workflow?: WorkflowGraph) {
  switch (mode) {
    case "single": return 1;
    case "compare": return participantCount;
    case "panel": return participantCount + 1;
    case "debate": return participantCount + participantCount * rounds + 1;
    case "critic-revise": return 3;
    case "consensus": return participantCount + 2;
    case "judge": return participantCount + 1;
    case "red-team": return 1 + Math.max(participantCount - 1, 1) + 1;
    case "router": return 2;
    case "research-council": return participantCount + 1;
    case "planner-executor": return 1 + Math.max(participantCount - 1, 1) + 1;
    case "custom": return workflow?.nodes.length ?? 0;
  }
}

function modelKey(model: ModelRef) {
  return `${model.provider}:${model.model}`;
}

function initialSelection(models: ModelRef[]) {
  const slots: Array<{ provider: ProviderId; mockModel: string }> = [
    { provider: "openai", mockModel: "mock-gpt" },
    { provider: "anthropic", mockModel: "mock-claude" },
    { provider: "xai", mockModel: "mock-grok" },
  ];

  return slots
    .map(slot => {
      const realModels = models.filter(model => model.provider === slot.provider && model.source === "subscription");
      return realModels.find(model => model.isDefault)
        ?? realModels[0]
        ?? models.find(model => model.model === slot.mockModel);
    })
    .filter((model): model is ModelRef => Boolean(model))
    .map(modelKey);
}

function runtimeName(status: ProviderStatus) {
  const plan = status.planType ? ` ${status.planType}` : "";
  if (status.id === "openai") return `ChatGPT${plan}`;
  if (status.id === "anthropic") return `Claude${plan}`;
  if (status.id === "xai") return `Grok${plan}`;
  return status.label;
}

function freshUsage(): RunUsage {
  return { callsStarted: 0, callsCompleted: 0, inputTokens: 0, outputTokens: 0, tokenReports: 0 };
}

function durationLabel(minutes?: number) {
  if (!minutes) return "window";
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function elapsedLabel(ms?: number) {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function limitText(snapshot: ProviderLimitSnapshot) {
  if (!snapshot.available) return "";
  const windows = [snapshot.primary, snapshot.secondary]
    .filter((window): window is NonNullable<typeof window> => Boolean(window))
    .map(window => `${durationLabel(window.windowDurationMins)} ${window.usedPercent}% used`);
  return windows.join(" · ");
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseWorkflow(raw: string): { graph?: WorkflowGraph; error: string } {
  if (!raw.trim()) return { graph: undefined, error: "Choose a preset or enter a workflow graph." };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { graph: undefined, error: "Workflow JSON must be an object." };
    }
    const graph = parsed as WorkflowGraph;
    if (typeof graph.name !== "string" || !graph.name.trim() || !Array.isArray(graph.nodes) || typeof graph.outputNodeId !== "string" || !graph.outputNodeId.trim()) {
      return { graph: undefined, error: "Workflow JSON must include a string name, nodes array, and outputNodeId." };
    }
    if (graph.nodes.length === 0) return { graph: undefined, error: "Workflow must contain at least one node." };
    if (graph.nodes.length > 64) return { graph: undefined, error: "Workflow cannot contain more than 64 nodes." };

    const byId = new Map<string, WorkflowGraph["nodes"][number]>();
    for (const candidate of graph.nodes) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return { graph: undefined, error: "Every workflow node must be an object." };
      }
      if (typeof candidate.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(candidate.id)) {
        return { graph: undefined, error: `Invalid workflow node ID '${String(candidate.id)}'.` };
      }
      if (byId.has(candidate.id)) return { graph: undefined, error: `Workflow node '${candidate.id}' is duplicated.` };
      if (typeof candidate.kind !== "string" || !workflowKinds.has(candidate.kind)) {
        return { graph: undefined, error: `Workflow node '${candidate.id}' has unsupported kind '${String(candidate.kind)}'.` };
      }
      if (typeof candidate.promptTemplate !== "string" || !candidate.promptTemplate.trim()) {
        return { graph: undefined, error: `Workflow node '${candidate.id}' requires a string promptTemplate.` };
      }
      if (!candidate.model || typeof candidate.model !== "object" || Array.isArray(candidate.model)) {
        return { graph: undefined, error: `Workflow node '${candidate.id}' needs a model selector.` };
      }
      if (candidate.model.type === "participant") {
        if (!Number.isInteger(candidate.model.index) || candidate.model.index < 0) {
          return { graph: undefined, error: `Workflow node '${candidate.id}' has an invalid participant index.` };
        }
      } else if (candidate.model.type !== "synthesizer") {
        return { graph: undefined, error: `Workflow node '${candidate.id}' has an unsupported model selector.` };
      }
      if (candidate.dependsOn !== undefined && !Array.isArray(candidate.dependsOn)) {
        return { graph: undefined, error: `Workflow node '${candidate.id}' dependsOn must be an array.` };
      }
      if ((candidate.dependsOn ?? []).some(dependency => typeof dependency !== "string")) {
        return { graph: undefined, error: `Workflow node '${candidate.id}' dependencies must be node IDs.` };
      }
      byId.set(candidate.id, candidate);
    }

    if (!byId.has(graph.outputNodeId)) {
      return { graph: undefined, error: `Workflow output node '${graph.outputNodeId}' does not exist.` };
    }

    for (const node of graph.nodes) {
      const dependencies = node.dependsOn ?? [];
      if (new Set(dependencies).size !== dependencies.length) {
        return { graph: undefined, error: `Workflow node '${node.id}' contains duplicate dependencies.` };
      }
      for (const dependency of dependencies) {
        if (dependency === node.id) return { graph: undefined, error: `Workflow node '${node.id}' cannot depend on itself.` };
        if (!byId.has(dependency)) return { graph: undefined, error: `Workflow node '${node.id}' depends on missing node '${dependency}'.` };
      }
      const explicitRefs = [...node.promptTemplate.matchAll(/\{\{dep\.([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/g)].map(match => match[1]);
      const hidden = explicitRefs.find(reference => !dependencies.includes(reference));
      if (hidden) return { graph: undefined, error: `Workflow node '${node.id}' references '${hidden}' without declaring it in dependsOn.` };
    }

    const state = new Map<string, "visiting" | "done">();
    const visit = (nodeId: string): boolean => {
      const current = state.get(nodeId);
      if (current === "visiting") return false;
      if (current === "done") return true;
      state.set(nodeId, "visiting");
      const node = byId.get(nodeId)!;
      for (const dependency of node.dependsOn ?? []) {
        if (!visit(dependency)) return false;
      }
      state.set(nodeId, "done");
      return true;
    };
    if (!graph.nodes.every(node => visit(node.id))) {
      return { graph: undefined, error: "Workflow graph contains a dependency cycle." };
    }

    const outputCone = new Set<string>();
    const includeAncestors = (nodeId: string) => {
      if (outputCone.has(nodeId)) return;
      outputCone.add(nodeId);
      for (const dependency of byId.get(nodeId)?.dependsOn ?? []) includeAncestors(dependency);
    };
    includeAncestors(graph.outputNodeId);
    const unused = graph.nodes.filter(node => !outputCone.has(node.id)).map(node => node.id);
    if (unused.length > 0) {
      return { graph: undefined, error: `Workflow node${unused.length === 1 ? "" : "s"} not connected to output: ${unused.join(", ")}.` };
    }

    return { graph, error: "" };
  } catch (cause) {
    return { graph: undefined, error: cause instanceof Error ? `Invalid workflow JSON: ${cause.message}` : "Invalid workflow JSON." };
  }
}

function App() {
  const [models, setModels] = useState<ModelRef[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState("");
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState("");
  const [providerLimits, setProviderLimits] = useState<ProviderLimitSnapshot[]>([]);
  const [workflowPresets, setWorkflowPresets] = useState<WorkflowPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [workflowText, setWorkflowText] = useState("");
  const [synthesizerKey, setSynthesizerKey] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<OrchestrationMode>("panel");
  const [setupOpen, setSetupOpen] = useState(true);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<OrchestrationResult | null>(null);
  const [liveSteps, setLiveSteps] = useState<OrchestrationStep[]>([]);
  const [completedStepIds, setCompletedStepIds] = useState<string[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [resumeRunId, setResumeRunId] = useState<string | null>(null);
  const [runUsage, setRunUsage] = useState<RunUsage>(freshUsage);
  const [rateLimit, setRateLimit] = useState<RateLimitNotice | null>(null);
  const [inspection, setInspection] = useState<RunInspection | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [maxCalls, setMaxCalls] = useState(12);
  const [maxRounds, setMaxRounds] = useState(1);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const viewEpochRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const workflowPresetsRef = useRef<WorkflowPreset[]>([]);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const epoch = beginViewOperation();
    void initialize(epoch);
    return () => {
      streamAbortRef.current?.abort();
      viewEpochRef.current += 1;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("conclave.theme", theme);
  }, [theme]);

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    const nextHeight = Math.max(36, Math.min(textarea.scrollHeight, 180));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? "auto" : "hidden";
  }, [prompt]);

  useEffect(() => {
    if (!inspectorOpen || !activeRunId) return;
    const epoch = viewEpochRef.current;
    const runId = activeRunId;
    void refreshInspector(runId, epoch, true);
    if (!loading) return;
    const timer = window.setInterval(() => {
      void refreshInspector(runId, epoch, false);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [inspectorOpen, activeRunId, loading]);

  const participants = useMemo(
    () => selected
      .map(key => models.find(model => modelKey(model) === key))
      .filter((model): model is ModelRef => Boolean(model)),
    [models, selected],
  );
  const selectedSynthesizer = synthesizerKey
    ? participants.find(model => modelKey(model) === synthesizerKey)
    : undefined;
  const workflowState = useMemo(() => parseWorkflow(workflowText), [workflowText]);
  const activeWorkflow = mode === "custom" ? workflowState.graph : undefined;
  const workflowInvalid = mode === "custom" && !activeWorkflow;
  const requiredParticipants = mode === "custom"
    ? requiredWorkflowParticipants(activeWorkflow)
    : minimumParticipants(mode);
  const participantShortfall = participants.length < requiredParticipants;
  const expectedCalls = plannedCalls(mode, participants.length, maxRounds, activeWorkflow);
  const budgetShortfall = !participantShortfall && !workflowInvalid && expectedCalls > maxCalls;

  const priorMessages = useMemo(
    () => conversation?.messages.filter(
      message => !(message.runId === activeRunId && message.role === "assistant"),
    ) ?? [],
    [conversation, activeRunId],
  );

  const subscriptionProviders = providers.filter(provider => provider.id !== "mock");
  const connectedProviders = subscriptionProviders.filter(provider => provider.connected);
  const runtimeLabel = providersLoading
    ? "Checking subscription runtimes…"
    : connectedProviders.length > 0
      ? `${connectedProviders.map(runtimeName).join(" · ")} connected`
      : providers.length === 0
        ? "Runtime status unavailable"
        : "Subscription runtimes not connected · mocks active";
  const runtimeTitle = providersLoading
    ? "Checking local subscription runtimes…"
    : providersError || subscriptionProviders
      .map(provider => `${runtimeName(provider)}: ${provider.message ?? (provider.connected ? "connected" : "not connected")}`)
      .join("\n");
  const quotaSummary = providerLimits.map(limitText).filter(Boolean).join(" · ");
  const quotaTitle = providerLimits
    .map(snapshot => `${snapshot.provider}: ${limitText(snapshot) || snapshot.message || "structured limits unavailable"}`)
    .join("\n");

  function beginViewOperation() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    viewEpochRef.current += 1;
    return viewEpochRef.current;
  }

  function isCurrent(epoch: number) {
    return viewEpochRef.current === epoch;
  }

  function setPreset(presetId: string) {
    setSelectedPresetId(presetId);
    const preset = workflowPresetsRef.current.find(item => item.id === presetId);
    if (preset) setWorkflowText(JSON.stringify(preset.graph, null, 2));
  }

  function adoptRun(run: StoredRun) {
    setRunUsage(run.usage ?? freshUsage());
    setRateLimit(run.rateLimit ?? null);
    setCancelling(run.status === "cancelling");
    setMode(run.request.mode);
    setSelected(run.request.participants.map(modelKey));
    setSynthesizerKey(run.request.synthesizer ? modelKey(run.request.synthesizer) : "");
    setMaxCalls(run.request.budget?.maxCalls ?? 12);
    setMaxRounds(run.request.budget?.maxRounds ?? run.request.maxRounds ?? 1);
    if (run.request.mode === "custom" && run.request.workflow) {
      setWorkflowText(JSON.stringify(run.request.workflow, null, 2));
      const preset = workflowPresetsRef.current.find(item => item.graph.id && item.graph.id === run.request.workflow?.id);
      setSelectedPresetId(preset?.id ?? "");
    }
  }

  async function refreshLimits(epoch?: number) {
    try {
      const limits = await fetch(`${API}/provider-limits`).then(response => readJson<ProviderLimitSnapshot[]>(response));
      if (epoch === undefined || isCurrent(epoch)) setProviderLimits(limits);
    } catch {
      // Quota telemetry is optional; a provider/runtime can omit it without
      // making the reasoning surface unavailable.
    }
  }

  async function loadModels(epoch: number) {
    if (isCurrent(epoch)) {
      setModelsLoading(true);
      setModelsError("");
    }
    try {
      const data = await fetch(`${API}/models`).then(response => readJson<ModelRef[]>(response));
      if (!isCurrent(epoch)) return;
      setModels(data);
      setSelected(current => current.length > 0 ? current : initialSelection(data));
    } catch (cause) {
      if (!isCurrent(epoch)) return;
      setModelsError(cause instanceof Error ? cause.message : "Could not load models.");
    } finally {
      if (isCurrent(epoch)) setModelsLoading(false);
    }
  }

  async function loadProviders(epoch: number) {
    if (isCurrent(epoch)) {
      setProvidersLoading(true);
      setProvidersError("");
    }
    try {
      const data = await fetch(`${API}/providers`).then(response => readJson<ProviderStatus[]>(response));
      if (!isCurrent(epoch)) return;
      setProviders(data);
    } catch (cause) {
      if (!isCurrent(epoch)) return;
      setProviders([]);
      setProvidersError(cause instanceof Error ? cause.message : "Could not load runtime status.");
    } finally {
      if (isCurrent(epoch)) setProvidersLoading(false);
    }
  }

  async function refreshRuntimeCatalog(epoch: number) {
    // Native runtime discovery can be comparatively slow. Keep it independent
    // from conversation/preset bootstrap so one status call cannot blank the
    // whole setup screen.
    await Promise.all([loadModels(epoch), loadProviders(epoch)]);
    if (isCurrent(epoch)) await refreshLimits(epoch);
  }

  async function initialize(epoch: number) {
    void refreshRuntimeCatalog(epoch);
    try {
      const [conversationData, presetData] = await Promise.all([
        fetch(`${API}/conversations`).then(response => readJson<ConversationSummary[]>(response)),
        fetch(`${API}/workflow-presets`)
          .then(response => readJson<WorkflowPreset[]>(response))
          .catch(() => [] as WorkflowPreset[]),
      ]);
      if (!isCurrent(epoch)) return;
      setConversations(conversationData);
      workflowPresetsRef.current = presetData;
      setWorkflowPresets(presetData);
      if (presetData[0]) {
        setSelectedPresetId(presetData[0].id);
        setWorkflowText(JSON.stringify(presetData[0].graph, null, 2));
      }

      const rememberedRun = localStorage.getItem("conclave.activeRunId");
      const rememberedConversation = localStorage.getItem("conclave.conversationId");
      if (rememberedRun) {
        await recoverRun(rememberedRun, epoch);
      } else if (rememberedConversation && conversationData.some(item => item.id === rememberedConversation)) {
        await loadConversation(rememberedConversation, epoch);
      }
    } catch (cause) {
      if (isCurrent(epoch)) {
        setError(cause instanceof Error ? cause.message : "Could not load local conversation history.");
      }
    }
  }

  async function refreshConversations(epoch?: number) {
    const data = await fetch(`${API}/conversations`).then(response => readJson<ConversationSummary[]>(response));
    if (epoch === undefined || isCurrent(epoch)) setConversations(data);
  }

  async function loadConversation(id: string, existingEpoch?: number) {
    const epoch = existingEpoch ?? beginViewOperation();
    if (existingEpoch === undefined) {
      setLoading(false);
      setCancelling(false);
      setError("");
      setResult(null);
      setLiveSteps([]);
      setCompletedStepIds([]);
      setResumeRunId(null);
      setRunUsage(freshUsage());
      setRateLimit(null);
      setInspection(null);
      setInspectorOpen(false);
    }

    const data = await fetch(`${API}/conversations/${id}`).then(response => readJson<Conversation>(response));
    if (!isCurrent(epoch)) return;
    setConversation(data);
    setSetupOpen(false);
    localStorage.setItem("conclave.conversationId", id);

    if (data.lastRunId) {
      const run = await fetch(`${API}/runs/${data.lastRunId}`).then(response => readJson<StoredRun>(response));
      if (!isCurrent(epoch)) return;
      adoptRun(run);
      setActiveRunId(run.id);
      localStorage.setItem("conclave.activeRunId", run.id);
      if (run.status === "completed" && run.result) {
        setError("");
        setResult(run.result);
        setLiveSteps(run.result.steps);
        setCompletedStepIds(run.result.steps.map(step => step.id));
        setResumeRunId(null);
      } else if (["running", "queued", "cancelling"].includes(run.status)) {
        await recoverRun(run.id, epoch);
      } else {
        await replayPersistedRun(run.id, epoch);
        if (!isCurrent(epoch)) return;
        setResumeRunId(run.id);
        setError(run.error ?? "This run stopped before it completed.");
      }
    } else {
      setError("");
      setActiveRunId(null);
      setResult(null);
      setLiveSteps([]);
      setCompletedStepIds([]);
      setResumeRunId(null);
      setRunUsage(freshUsage());
      setRateLimit(null);
      localStorage.removeItem("conclave.activeRunId");
    }
  }

  async function recoverRun(runId: string, existingEpoch?: number) {
    const epoch = existingEpoch ?? beginViewOperation();
    try {
      const run = await fetch(`${API}/runs/${runId}`).then(response => readJson<StoredRun>(response));
      if (!isCurrent(epoch)) return;
      adoptRun(run);
      setActiveRunId(run.id);
      localStorage.setItem("conclave.activeRunId", run.id);
      localStorage.setItem("conclave.conversationId", run.conversationId);
      const thread = await fetch(`${API}/conversations/${run.conversationId}`).then(response => readJson<Conversation>(response));
      if (!isCurrent(epoch)) return;
      setConversation(thread);
      setSetupOpen(false);

      if (run.status === "completed" && run.result) {
        setError("");
        setResult(run.result);
        setLiveSteps(run.result.steps);
        setCompletedStepIds(run.result.steps.map(step => step.id));
        setLoading(false);
        setCancelling(false);
        setResumeRunId(null);
        return;
      }

      if (["failed", "interrupted", "cancelled"].includes(run.status)) {
        await replayPersistedRun(run.id, epoch);
        if (!isCurrent(epoch)) return;
        setError(run.error ?? "This run stopped before it completed.");
        setResumeRunId(run.id);
        setLoading(false);
        setCancelling(false);
        return;
      }

      setResult(null);
      setLiveSteps([]);
      setCompletedStepIds([]);
      setError(run.status === "cancelling" ? "Stopping the active provider call…" : "");
      setResumeRunId(null);
      setLoading(true);
      const attached = await consumeRun(run.id, epoch);
      if (attached && isCurrent(epoch)) await refreshConversation(run.conversationId, epoch);
    } finally {
      if (isCurrent(epoch)) setLoading(false);
    }
  }

  async function refreshConversation(id: string, epoch?: number) {
    const data = await fetch(`${API}/conversations/${id}`).then(response => readJson<Conversation>(response));
    if (epoch !== undefined && !isCurrent(epoch)) return;
    setConversation(data);
    await refreshConversations(epoch);
  }

  function newConversation() {
    beginViewOperation();
    setConversation(null);
    setSetupOpen(true);
    setActiveRunId(null);
    setResumeRunId(null);
    setResult(null);
    setLiveSteps([]);
    setCompletedStepIds([]);
    setRunUsage(freshUsage());
    setRateLimit(null);
    setInspection(null);
    setInspectorOpen(false);
    setSynthesizerKey("");
    setLoading(false);
    setCancelling(false);
    setError("");
    setPrompt("");
    localStorage.removeItem("conclave.conversationId");
    localStorage.removeItem("conclave.activeRunId");
  }

  function selectMode(nextMode: OrchestrationMode) {
    setMode(nextMode);
    if (nextMode === "single") {
      setSynthesizerKey("");
      setSelected(current => {
        const model = current[0] ?? (models[0] ? modelKey(models[0]) : undefined);
        return model ? [model] : [];
      });
      return;
    }

    const minimum = nextMode === "custom"
      ? requiredWorkflowParticipants(parseWorkflow(workflowText).graph)
      : minimumParticipants(nextMode);
    if (minimum > 1) {
      setSelected(current => {
        const next = [...current];
        for (const model of models) {
          const key = modelKey(model);
          if (!next.includes(key)) next.push(key);
          if (next.length >= minimum) break;
        }
        return next;
      });
    }
  }

  function toggleModel(model: ModelRef) {
    const key = modelKey(model);
    if (mode === "single") {
      setSelected([key]);
      return;
    }
    setSelected(current => {
      if (current.includes(key)) {
        if (synthesizerKey === key) setSynthesizerKey("");
        return current.filter(id => id !== key);
      }
      return [...current, key];
    });
  }

  function applyStreamEvent(streamEvent: OrchestrationStreamEvent) {
    if (streamEvent.type === "run_usage") {
      setRunUsage(streamEvent.usage);
      return;
    }

    if (streamEvent.type === "rate_limit") {
      setRateLimit(streamEvent.notice);
      return;
    }

    if (streamEvent.type === "run_cancelled") {
      setCancelling(false);
      setError(streamEvent.message);
      setResumeRunId(streamEvent.runId);
      return;
    }

    if (streamEvent.type === "step_started") {
      setCompletedStepIds(current => current.filter(id => id !== streamEvent.stepId));
      setLiveSteps(current => current.some(step => step.id === streamEvent.stepId)
        ? current
        : [...current, {
            id: streamEvent.stepId,
            kind: streamEvent.kind,
            model: streamEvent.model,
            content: "",
            dependsOn: streamEvent.dependsOn,
          }]);
      return;
    }

    if (streamEvent.type === "text_delta") {
      setLiveSteps(current => current.map(step => step.id === streamEvent.stepId
        ? { ...step, content: step.content + streamEvent.delta }
        : step));
      return;
    }

    if (streamEvent.type === "step_completed") {
      setLiveSteps(current => current.some(step => step.id === streamEvent.step.id)
        ? current.map(step => step.id === streamEvent.step.id ? streamEvent.step : step)
        : [...current, streamEvent.step]);
      setCompletedStepIds(current => current.includes(streamEvent.step.id) ? current : [...current, streamEvent.step.id]);
      return;
    }

    if (streamEvent.type === "run_completed") {
      setResult(streamEvent.result);
      setLiveSteps(streamEvent.result.steps);
      setCompletedStepIds(streamEvent.result.steps.map(step => step.id));
      setResumeRunId(null);
      setCancelling(false);
      return;
    }

    if (streamEvent.type === "error") {
      setError(streamEvent.message);
    }
  }

  async function replayPersistedRun(runId: string, epoch: number) {
    setResult(null);
    setLiveSteps([]);
    setCompletedStepIds([]);

    const response = await fetch(`${API}/runs/${runId}/events?after=0&follow=0`);
    if (!response.ok) await readJson(response);
    const body = await response.text();
    if (!isCurrent(epoch)) return false;

    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !isCurrent(epoch)) continue;
      const record = JSON.parse(trimmed) as RunEventRecord;
      applyStreamEvent(record.event);
    }
    return isCurrent(epoch);
  }

  async function consumeRun(runId: string, epoch: number) {
    let cursor = 0;
    const controller = new AbortController();
    streamAbortRef.current?.abort();
    streamAbortRef.current = controller;

    try {
      while (isCurrent(epoch) && !controller.signal.aborted) {
        try {
          const response = await fetch(`${API}/runs/${runId}/events?after=${cursor}&follow=1`, {
            signal: controller.signal,
          });
          if (!response.ok) await readJson(response);
          if (!response.body) throw new Error("This browser did not expose the response stream.");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          const consumeLine = (line: string) => {
            const trimmed = line.trim();
            if (!trimmed || !isCurrent(epoch) || controller.signal.aborted) return;
            const record = JSON.parse(trimmed) as RunEventRecord;
            cursor = Math.max(cursor, record.seq);
            applyStreamEvent(record.event);
          };

          while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) consumeLine(line);
            if (done) break;
          }
          if (buffer.trim()) consumeLine(buffer);
        } catch (cause) {
          if (controller.signal.aborted || !isCurrent(epoch)) return false;
        }

        if (controller.signal.aborted || !isCurrent(epoch)) return false;

        let run!: StoredRun;
        try {
          run = await fetch(`${API}/runs/${runId}`, { signal: controller.signal })
            .then(next => readJson<StoredRun>(next));
        } catch (cause) {
          if (controller.signal.aborted || !isCurrent(epoch)) return false;
          await sleep(600);
          continue;
        }

        if (!isCurrent(epoch)) return false;
        setRunUsage(run.usage ?? freshUsage());
        setRateLimit(run.rateLimit ?? null);
        setCancelling(run.status === "cancelling");
        if (run.status === "completed") {
          if (run.result) {
            setError("");
            setResult(run.result);
            setLiveSteps(run.result.steps);
            setCompletedStepIds(run.result.steps.map(step => step.id));
          }
          setResumeRunId(null);
          await refreshLimits(epoch);
          return true;
        }
        if (["failed", "interrupted", "cancelled"].includes(run.status)) {
          setError(run.error ?? "The run stopped before completion.");
          setResumeRunId(run.id);
          setCancelling(false);
          await refreshLimits(epoch);
          return true;
        }

        await sleep(500);
      }
      return false;
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
    }
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!loading && prompt.trim() && !participantShortfall && !budgetShortfall && !workflowInvalid) {
      composerRef.current?.requestSubmit();
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || participantShortfall || budgetShortfall || workflowInvalid || loading) return;
    const epoch = beginViewOperation();
    setLoading(true);
    setCancelling(false);
    setError("");
    setResumeRunId(null);
    setResult(null);
    setLiveSteps([]);
    setCompletedStepIds([]);
    setRunUsage(freshUsage());
    setRateLimit(null);
    setInspection(null);
    setInspectorOpen(false);

    try {
      const started = await fetch(`${API}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation?.id,
          request: {
            mode,
            prompt,
            participants,
            synthesizer: selectedSynthesizer,
            workflow: mode === "custom" ? activeWorkflow : undefined,
            budget: { maxCalls, maxRounds },
          },
        }),
      }).then(response => readJson<StartRunResponse>(response));
      if (!isCurrent(epoch)) return;

      setSetupOpen(false);
      setActiveRunId(started.runId);
      localStorage.setItem("conclave.activeRunId", started.runId);
      localStorage.setItem("conclave.conversationId", started.conversationId);
      setPrompt("");
      await refreshConversation(started.conversationId, epoch);
      if (!isCurrent(epoch)) return;
      const attached = await consumeRun(started.runId, epoch);
      if (attached && isCurrent(epoch)) await refreshConversation(started.conversationId, epoch);
    } catch (cause) {
      if (isCurrent(epoch)) {
        setError(cause instanceof Error ? cause.message : "Orchestration failed");
      }
    } finally {
      if (isCurrent(epoch)) {
        setLoading(false);
        setCancelling(false);
      }
    }
  }

  async function cancelActiveRun() {
    if (!activeRunId || !loading || cancelling) return;
    const epoch = viewEpochRef.current;
    const runId = activeRunId;
    setCancelling(true);
    setError("Stopping the active provider call…");
    try {
      const run = await fetch(`${API}/runs/${runId}/cancel`, { method: "POST" })
        .then(response => readJson<StoredRun>(response));
      if (!isCurrent(epoch)) return;
      setRunUsage(run.usage ?? freshUsage());
      if (run.status === "completed") {
        setCancelling(false);
        setError("");
        if (run.result) {
          setResult(run.result);
          setLiveSteps(run.result.steps);
          setCompletedStepIds(run.result.steps.map(step => step.id));
        }
      }
    } catch (cause) {
      if (!isCurrent(epoch)) return;
      setCancelling(false);
      setError(cause instanceof Error ? cause.message : "Could not cancel run");
    }
  }

  async function resumeInterruptedRun() {
    if (!resumeRunId || loading) return;
    const epoch = beginViewOperation();
    const runId = resumeRunId;
    setLoading(true);
    setCancelling(false);
    setError("");
    setResult(null);
    setLiveSteps([]);
    setCompletedStepIds([]);
    setRunUsage(freshUsage());
    setRateLimit(null);
    setInspection(null);
    setInspectorOpen(false);
    try {
      const resumed = await fetch(`${API}/runs/${runId}/resume`, { method: "POST" })
        .then(response => readJson<StartRunResponse>(response));
      if (!isCurrent(epoch)) return;
      setActiveRunId(resumed.runId);
      setResumeRunId(null);
      localStorage.setItem("conclave.activeRunId", resumed.runId);
      localStorage.setItem("conclave.conversationId", resumed.conversationId);
      const attached = await consumeRun(resumed.runId, epoch);
      if (attached && isCurrent(epoch)) await refreshConversation(resumed.conversationId, epoch);
    } catch (cause) {
      if (isCurrent(epoch)) {
        setError(cause instanceof Error ? cause.message : "Could not resume run");
      }
    } finally {
      if (isCurrent(epoch)) setLoading(false);
    }
  }

  async function refreshInspector(runId: string, epoch: number, showLoading: boolean) {
    if (showLoading && isCurrent(epoch)) setInspectorLoading(true);
    try {
      const data = await fetch(`${API}/runs/${runId}/inspection`).then(response => readJson<RunInspection>(response));
      if (!isCurrent(epoch)) return;
      setInspection(data);
    } catch (cause) {
      if (showLoading && isCurrent(epoch)) {
        setError(cause instanceof Error ? cause.message : "Could not load run inspection");
      }
    } finally {
      if (showLoading && isCurrent(epoch)) setInspectorLoading(false);
    }
  }

  function toggleInspector() {
    if (inspectorOpen) {
      setInspectorOpen(false);
      return;
    }
    if (!activeRunId) return;
    setInspection(null);
    setInspectorOpen(true);
  }

  const displayedSteps = result?.steps ?? liveSteps;
  const tokenText = runUsage.tokenReports > 0
    ? `${runUsage.inputTokens.toLocaleString()} in · ${runUsage.outputTokens.toLocaleString()} out`
    : "token telemetry unavailable";
  const selectedPreset = workflowPresets.find(item => item.id === selectedPresetId);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div>
          <div className="brand-mark">C</div>
          <h1>Conclave</h1>
          <p className="muted">Many models. One reasoning space.</p>
        </div>
        <button className="new-chat" onClick={newConversation}>+ New conversation</button>
        {conversations.length > 0 && (
          <div className="conversation-list">
            <span className="eyebrow">RECENT</span>
            {conversations.slice(0, 8).map(item => (
              <button
                key={item.id}
                className={conversation?.id === item.id ? "conversation-link active" : "conversation-link"}
                onClick={() => void loadConversation(item.id)}
                title={item.title}
              >
                <span>{item.title}</span>
                <small>{item.messageCount} messages</small>
              </button>
            ))}
          </div>
        )}
        {quotaSummary && <div className="quota" title={quotaTitle}>{quotaSummary}</div>}
        <div className="sidebar-footer">
          <button
            className="theme-toggle"
            type="button"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            onClick={() => setTheme(current => current === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          <div className="status" title={runtimeTitle}><span className="dot" /> {runtimeLabel}</div>
        </div>
      </aside>

      <section className="workspace">

        <div className="content">
          {setupOpen && (
            <RunSetup
              mode={mode}
              fresh={!conversation}
              modes={modes}
              onModeChange={selectMode}
              models={models}
              modelsLoading={modelsLoading}
              modelsError={modelsError}
              onRetryModels={() => void refreshRuntimeCatalog(viewEpochRef.current)}
              selectedKeys={selected}
              participants={participants}
              onToggleModel={toggleModel}
              synthesizerKey={synthesizerKey}
              onSynthesizerChange={setSynthesizerKey}
              maxCalls={maxCalls}
              onMaxCallsChange={setMaxCalls}
              maxRounds={maxRounds}
              onMaxRoundsChange={setMaxRounds}
              expectedCalls={expectedCalls}
              loading={loading}
            />
          )}
          {setupOpen && mode === "custom" && (
            <section className="workflow-panel">
              <div className="workflow-panel-head">
                <div>
                  <span className="eyebrow">WORKFLOW GRAPH</span>
                  <h3>{activeWorkflow?.name ?? "Custom workflow"}</h3>
                  <p>{activeWorkflow?.description ?? selectedPreset?.description ?? "Build a bounded dependency graph for this run."}</p>
                </div>
                <label className="workflow-preset-picker">
                  <span>Preset</span>
                  <select value={selectedPresetId} disabled={loading} onChange={event => setPreset(event.target.value)}>
                    <option value="">Edited / custom</option>
                    {workflowPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                  </select>
                </label>
              </div>
              <div className="workflow-summary">
                <span>{activeWorkflow?.nodes.length ?? 0} nodes</span>
                <span>{requiredParticipants} participant slot{requiredParticipants === 1 ? "" : "s"}</span>
                <span>output · {activeWorkflow?.outputNodeId ?? "—"}</span>
              </div>
              <details className="workflow-editor">
                <summary>Advanced · edit workflow JSON</summary>
                <textarea
                  value={workflowText}
                  disabled={loading}
                  spellCheck={false}
                  onChange={event => {
                    setWorkflowText(event.target.value);
                    setSelectedPresetId("");
                  }}
                />
                {workflowState.error && <div className="workflow-error">{workflowState.error}</div>}
                <p>Templates support <code>{"{{prompt}}"}</code>, <code>{"{{dependencies}}"}</code>, and declared <code>{"{{dep.nodeId}}"}</code> references.</p>
              </details>
            </section>
          )}

          {priorMessages.length > 0 && (
            <section className="conversation-history" aria-label="Conversation history">
              {priorMessages.map(message => (
                <article key={message.id} className={`message ${message.role}`}>
                  <span className="eyebrow">{message.role === "user" ? "YOU" : "CONCLAVE"}</span>
                  <Markdown content={message.content} />
                </article>
              ))}
            </section>
          )}

          {!result && !loading && displayedSteps.length === 0 && priorMessages.length === 0 && mode !== "custom" && !setupOpen && (
            <section className="hero">
              <span className="eyebrow">CONVENE THE COUNCIL</span>
              <h3>Ask once. Let different minds work the problem.</h3>
              <p>Compare, debate, route to a specialist, red-team a draft, build consensus, or run a plan through executors and review.</p>
            </section>
          )}

          {loading && displayedSteps.length === 0 && (
            <div className="thinking"><span /> <span /> <span /> {cancelling ? "Stopping provider work…" : "Run continues even if this tab disconnects…"}</div>
          )}
          {error && (
            <div className="error">
              <span>{error}</span>
              {resumeRunId && !loading && <button type="button" onClick={() => void resumeInterruptedRun()}>Resume run</button>}
            </div>
          )}
          {rateLimit && (
            <div className="rate-limit">Rate limit · {rateLimit.provider}/{rateLimit.model}: {rateLimit.message}</div>
          )}

          {inspectorOpen && (
            <section className="run-inspector" aria-label="Run inspector">
              <div className="run-inspector-head">
                <div>
                  <span className="eyebrow">RUN INSPECTOR</span>
                  <h3>{inspection?.run.request.mode ?? mode}</h3>
                </div>
                <div className="inspector-head-actions">
                  {inspection && <span className={`run-state state-${inspection.run.status}`}>{inspection.run.status}</span>}
                  <button type="button" className="drawer-close" aria-label="Close run details" onClick={() => setInspectorOpen(false)}>×</button>
                </div>
              </div>
              {inspectorLoading && <p className="muted">Loading persisted attempts…</p>}
              {inspection?.attempts.map(attempt => (
                <details className="attempt-card" key={attempt.attempt} open={attempt.attempt === inspection.run.attempt}>
                  <summary>
                    <strong>Attempt {attempt.attempt}</strong>
                    <span>{attempt.status}</span>
                    <span>{elapsedLabel(attempt.durationMs)}</span>
                    <span>{attempt.usage.callsStarted} calls</span>
                    {attempt.usage.tokenReports > 0 && <span>{attempt.usage.inputTokens} in / {attempt.usage.outputTokens} out</span>}
                  </summary>
                  {attempt.error && <div className="attempt-error">{attempt.error}</div>}
                  {attempt.rateLimit && <div className="attempt-rate-limit">{attempt.rateLimit.provider}/{attempt.rateLimit.model} · {attempt.rateLimit.message}</div>}
                  <div className="inspection-steps">
                    {attempt.steps.map(step => (
                      <div className="inspection-step" key={step.id}>
                        <div>
                          <strong>{step.id}</strong>
                          <span>{step.kind ?? "step"} · {step.model?.label ?? "model pending"}</span>
                        </div>
                        <div className="inspection-step-meta">
                          <span>{step.status}</span>
                          <span>{elapsedLabel(step.durationMs)}</span>
                          {(step.inputTokens !== undefined || step.outputTokens !== undefined) && (
                            <span>{step.inputTokens ?? 0} in / {step.outputTokens ?? 0} out</span>
                          )}
                        </div>
                        {step.dependsOn.length > 0 && <small>after → {step.dependsOn.join(" · ")}</small>}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </section>
          )}

          {(displayedSteps.length > 0 || result) && (
            <section className="results">
              {result && (
                <div className="final-card">
                  <span className="eyebrow">FINAL</span>
                  <Markdown content={result.final} />
                </div>
              )}
              <div className="run-telemetry">
                <span>{runUsage.callsStarted}/{maxCalls} calls started</span>
                <span>{runUsage.callsCompleted} completed</span>
                <span>{tokenText}</span>
              </div>
              {loading && <div className="stream-status"><span className="dot" /> {cancelling ? "Cancelling…" : "Live · persisted locally"}</div>}
              {!loading && resumeRunId && displayedSteps.length > 0 && (
                <div className="stream-status">Partial output · previous attempt</div>
              )}
              <CouncilWork
                steps={displayedSteps}
                loading={loading}
                inspection={inspection}
                completedStepIds={completedStepIds}
                onInspect={toggleInspector}
              />
            </section>
          )}
        </div>

        <form className="composer" ref={composerRef} onSubmit={submit}>
          <RunConfigSummary
            mode={mode}
            modes={modes}
            participants={participants}
            synthesizer={selectedSynthesizer}
            onConfigure={() => setSetupOpen(current => !current)}
            onInspect={toggleInspector}
            canInspect={Boolean(activeRunId)}
          />
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            onKeyDown={handlePromptKeyDown}
            placeholder={conversation ? "Continue the conversation…" : mode === "custom" ? "Give this workflow a task…" : "Ask the council…"}
            rows={1}
          />
          <div className="composer-footer">
            <span className="composer-hint">{workflowInvalid
              ? workflowState.error
              : participantShortfall
                ? `${requiredParticipants} participants required for ${modes.find(item => item.id === mode)?.label}`
                : budgetShortfall
                  ? `Increase call budget to at least ${expectedCalls}`
                  : conversation
                    ? "Persistent conversation · Enter sends · Shift+Enter newline"
                    : `${participants.length} participant${participants.length === 1 ? "" : "s"} · Enter sends`}</span>
            <div className="composer-actions">
              {loading && (
                <button className="stop-run" type="button" disabled={cancelling} onClick={() => void cancelActiveRun()}>
                  {cancelling ? "Stopping…" : "Stop"}
                </button>
              )}
              <button type="submit" disabled={loading || !prompt.trim() || participantShortfall || budgetShortfall || workflowInvalid}>
                {loading ? "Running…" : "Convene"}
              </button>
            </div>
          </div>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
