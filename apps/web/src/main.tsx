import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Conversation,
  ConversationExportFormat,
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
  StepFailure,
  StoredRun,
  WorkflowGraph,
  WorkflowPreset,
} from "@conclave/core";
import { api, readJson, saveBlob, sleep } from "./lib/api";
import { answerPhase, finalAnswerStepId, followDistance } from "./lib/final-step";
import { collapsePrompt } from "./lib/text";
import { isEditableTarget, matchShortcut } from "./lib/shortcuts";
import { formatDuration } from "./lib/text";
import { parseWorkflow, requiredParticipants, serializeWorkflow } from "./lib/workflow-model";
import { CouncilWork } from "./ui/council";
import { RunInspector } from "./ui/inspector";
import { Markdown } from "./ui/markdown";
import { CommandPalette, type Command } from "./ui/palette";
import {
  Icon,
  Keys,
  type ModeMeta,
  ProviderMark,
  defaultFinalizer,
  modeUsesSynthesizer,
  modelKey,
  synthesizerRole,
} from "./ui/primitives";
import { Rail } from "./ui/rail";
import { RunSetup } from "./ui/setup";
import { ShortcutsDialog } from "./ui/shortcuts-dialog";
import { WorkflowEditor } from "./ui/workflow-editor";
import "./styles.css";

const modes: ModeMeta[] = [
  { id: "single", label: "Single", description: "One model, one answer" },
  { id: "compare", label: "Compare", description: "Independent answers, side by side" },
  { id: "panel", label: "Panel", description: "Independent answers, then synthesis" },
  { id: "debate", label: "Debate", description: "Positions, bounded critique, judgment" },
  { id: "critic-revise", label: "Critic → Revise", description: "Draft, critique, revise" },
  { id: "consensus", label: "Consensus", description: "Find agreement, then audit it" },
  { id: "judge", label: "Judge", description: "Candidates, then one adjudication" },
  { id: "red-team", label: "Red Team", description: "Attack a draft, then harden it" },
  { id: "router", label: "Router", description: "Send the task to one specialist" },
  { id: "research-council", label: "Research Council", description: "Evidence, alternatives, risks, synthesis" },
  { id: "planner-executor", label: "Planner → Executors", description: "Plan, execute in parallel, review" },
  { id: "custom", label: "Custom Workflow", description: "Run a validated dependency graph" },
];

type Theme = "dark" | "light";

function initialTheme(): Theme {
  const saved = localStorage.getItem("conclave.theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function minimumParticipants(mode: OrchestrationMode) {
  return mode === "consensus" || mode === "judge" || mode === "router" || mode === "research-council" ? 2 : 1;
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

function freshUsage(): RunUsage {
  return { callsStarted: 0, callsCompleted: 0, inputTokens: 0, outputTokens: 0, tokenReports: 0 };
}

/**
 * One conversation turn. A pasted prompt can run to hundreds of lines, which
 * would bury the answer it belongs to, so a long one is shortened until asked
 * for. It is truncated rather than visually clipped: anything hidden behind a
 * clip is still in the DOM, so a link inside it stays focusable and tabbing
 * lands on something nobody can see.
 */
function Turn({ role, content }: { role: "user" | "assistant"; content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = role === "user" ? collapsePrompt(content) : undefined;
  const shown = preview && !expanded ? preview : content;

  return (
    <article className={`turn ${role === "user" ? "turn-you" : "turn-them"}`}>
      {role === "assistant" && <span className="eyebrow turn-label">Conclave</span>}
      <div className="bubble">
        <div className="bubble-body">
          <Markdown content={shown} />
        </div>
        {preview && (
          <button type="button" className="bubble-more" onClick={() => setExpanded(value => !value)}>
            {expanded ? "Show less" : "Show full prompt"}
          </button>
        )}
      </div>
    </article>
  );
}

function App() {
  /* ---------------------------------------------------------------- state */
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
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [rateLimit, setRateLimit] = useState<RateLimitNotice | null>(null);
  const [inspection, setInspection] = useState<RunInspection | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [maxCalls, setMaxCalls] = useState(12);
  const [maxRounds, setMaxRounds] = useState(1);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");

  /* UI-only state */
  const [railOpen, setRailOpen] = useState(() => window.innerWidth > 900);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [stuckToBottom, setStuckToBottom] = useState(true);
  // The newest output is the answer's tail, which sits above council work — so
  // "jump to latest" is not always downwards.
  const [latestAbove, setLatestAbove] = useState(false);
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const viewEpochRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const workflowPresetsRef = useRef<WorkflowPreset[]>([]);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const answerRef = useRef<HTMLElement | null>(null);

  /* ------------------------------------------------------------ derived */
  const participants = useMemo(
    () => selected
      .map(key => models.find(model => modelKey(model) === key))
      .filter((model): model is ModelRef => Boolean(model)),
    [models, selected],
  );
  const selectedSynthesizer = synthesizerKey
    ? models.find(model => modelKey(model) === synthesizerKey)
    : undefined;
  const effectiveSynthesizer = modeUsesSynthesizer(mode)
    ? selectedSynthesizer ?? defaultFinalizer(mode, participants, models)
    : undefined;
  const workflowState = useMemo(() => parseWorkflow(workflowText), [workflowText]);
  const activeWorkflow = mode === "custom" ? workflowState.graph : undefined;
  const workflowInvalid = mode === "custom" && !activeWorkflow;
  const neededParticipants = mode === "custom"
    ? requiredParticipants(activeWorkflow)
    : minimumParticipants(mode);
  const participantShortfall = participants.length < neededParticipants;
  const expectedCalls = plannedCalls(mode, participants.length, maxRounds, activeWorkflow);
  const budgetShortfall = !participantShortfall && !workflowInvalid && expectedCalls > maxCalls;
  const canSubmit = Boolean(prompt.trim()) && !loading && !participantShortfall && !budgetShortfall && !workflowInvalid;

  const priorMessages = useMemo(
    () => conversation?.messages.filter(
      message => !(message.runId === activeRunId && message.role === "assistant"),
    ) ?? [],
    [conversation, activeRunId],
  );
  const displayedSteps = result?.steps ?? liveSteps;
  // The step that produces the answer belongs in the answer, not in council
  // work: showing it in both means watching the same text write itself twice.
  const finalStepId = finalAnswerStepId(displayedSteps, result?.final);
  const finalStep = displayedSteps.find(step => step.id === finalStepId);
  const councilSteps = useMemo(
    () => displayedSteps.filter(step => step.id !== finalStepId),
    [displayedSteps, finalStepId],
  );
  const answerShows = answerPhase({
    hasResult: Boolean(result),
    loading,
    finalStepComplete: Boolean(finalStep && completedStepIds.includes(finalStep.id)),
  });
  const layered = paletteOpen || shortcutsOpen || inspectorOpen;
  const modeLabel = modes.find(item => item.id === mode)?.label ?? mode;

  /* ------------------------------------------------------------ effects */
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
    textarea.style.height = `${Math.max(40, Math.min(textarea.scrollHeight, 220))}px`;
    textarea.style.overflowY = textarea.scrollHeight > 220 ? "auto" : "hidden";
  }, [prompt]);

  // Conversation search runs on the server so message bodies are searchable,
  // not only titles.
  useEffect(() => {
    const epoch = viewEpochRef.current;
    const handle = window.setTimeout(async () => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      if (query) setSearching(true);
      try {
        const data = await api.conversations(query, controller.signal);
        if (isCurrent(epoch)) setConversations(data);
      } catch {
        // A superseded or failed search must never blank the rail.
      } finally {
        if (searchAbortRef.current === controller) {
          searchAbortRef.current = null;
          setSearching(false);
        }
      }
    }, query ? 180 : 0);
    return () => window.clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    if (!inspectorOpen || !activeRunId) return;
    const epoch = viewEpochRef.current;
    const runId = activeRunId;
    void refreshInspector(runId, epoch, true);
    if (!loading) return;
    const timer = window.setInterval(() => void refreshInspector(runId, epoch, false), 1000);
    return () => window.clearInterval(timer);
  }, [inspectorOpen, activeRunId, loading]);

  // A live elapsed clock makes a long run legible without opening the drawer.
  useEffect(() => {
    if (!loading || runStartedAt === null) return;
    setElapsed(Date.now() - runStartedAt);
    const timer = window.setInterval(() => setElapsed(Date.now() - runStartedAt), 1000);
    return () => window.clearInterval(timer);
  }, [loading, runStartedAt]);

  const distanceFromLatest = useCallback((surface: HTMLDivElement) => followDistance({
    answerBottom: answerRef.current?.getBoundingClientRect().bottom,
    viewBottom: surface.getBoundingClientRect().bottom,
    scrollHeight: surface.scrollHeight,
    scrollTop: surface.scrollTop,
    clientHeight: surface.clientHeight,
  }), []);

  // Long runs keep the newest output in view unless the reader scrolls away.
  useEffect(() => {
    if (!stuckToBottom || !loading) return;
    const surface = streamRef.current;
    if (!surface) return;
    const target = surface.scrollTop + distanceFromLatest(surface);
    surface.scrollTop = Math.max(0, Math.min(target, surface.scrollHeight - surface.clientHeight));
  }, [liveSteps, result, stuckToBottom, loading, distanceFromLatest]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /* Global keyboard model. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = matchShortcut(event, {
        typing: isEditableTarget(event.target),
        layered,
      });
      if (!action) return;

      switch (action) {
        case "palette":
          event.preventDefault();
          setPaletteOpen(true);
          break;
        case "submit":
          event.preventDefault();
          if (canSubmit) composerRef.current?.requestSubmit();
          break;
        case "stop":
          event.preventDefault();
          if (loading && !cancelling) void cancelActiveRun();
          break;
        case "focus-composer":
          event.preventDefault();
          promptRef.current?.focus();
          break;
        case "new-conversation":
          event.preventDefault();
          newConversation();
          break;
        case "configure":
          setSetupOpen(open => !open);
          break;
        case "details":
          toggleInspector();
          break;
        case "expand-all":
          expandAllSteps();
          break;
        case "collapse-all":
          setOpenSteps({});
          break;
        case "toggle-rail":
          setRailOpen(open => !open);
          break;
        case "toggle-theme":
          setTheme(current => (current === "dark" ? "light" : "dark"));
          break;
        case "help":
          event.preventDefault();
          setShortcutsOpen(true);
          break;
        case "dismiss":
          if (paletteOpen) setPaletteOpen(false);
          else if (shortcutsOpen) setShortcutsOpen(false);
          else if (inspectorOpen) setInspectorOpen(false);
          else if (railOpen && window.innerWidth <= 900) setRailOpen(false);
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  /* ------------------------------------------------------------ helpers */
  function beginViewOperation() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    viewEpochRef.current += 1;
    return viewEpochRef.current;
  }

  function isCurrent(epoch: number) {
    return viewEpochRef.current === epoch;
  }

  function expandAllSteps() {
    setOpenSteps(Object.fromEntries(councilSteps.map(step => [step.id, true])));
  }

  function setPreset(presetId: string) {
    setSelectedPresetId(presetId);
    const preset = workflowPresetsRef.current.find(item => item.id === presetId);
    if (preset) setWorkflowText(serializeWorkflow(preset.graph));
  }

  function applyWorkflowGraph(graph: WorkflowGraph) {
    setWorkflowText(serializeWorkflow(graph));
    setSelectedPresetId("");
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
    setRunStartedAt(Date.parse(run.attemptStartedAt ?? run.createdAt) || Date.now());
    if (run.request.mode === "custom" && run.request.workflow) {
      setWorkflowText(serializeWorkflow(run.request.workflow));
      const preset = workflowPresetsRef.current.find(item => item.graph.id && item.graph.id === run.request.workflow?.id);
      setSelectedPresetId(preset?.id ?? "");
    }
  }

  async function refreshLimits(epoch?: number) {
    try {
      const limits = await api.limits();
      if (epoch === undefined || isCurrent(epoch)) setProviderLimits(limits);
    } catch {
      // Quota telemetry is optional; a runtime can omit it without making the
      // reasoning surface unavailable.
    }
  }

  async function loadModels(epoch: number) {
    if (isCurrent(epoch)) {
      setModelsLoading(true);
      setModelsError("");
    }
    try {
      const data = await api.models();
      if (!isCurrent(epoch)) return;
      setModels(data);
      setSelected(current => (current.length > 0 ? current : initialSelection(data)));
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
      const data = await api.providers();
      if (isCurrent(epoch)) setProviders(data);
    } catch (cause) {
      if (!isCurrent(epoch)) return;
      setProviders([]);
      setProvidersError(cause instanceof Error ? cause.message : "Could not load runtime status.");
    } finally {
      if (isCurrent(epoch)) setProvidersLoading(false);
    }
  }

  async function refreshRuntimeCatalog(epoch: number) {
    // Native runtime discovery can be slow. Keep it independent from
    // conversation/preset bootstrap so one status call cannot blank the setup.
    await Promise.all([loadModels(epoch), loadProviders(epoch)]);
    if (isCurrent(epoch)) await refreshLimits(epoch);
  }

  async function initialize(epoch: number) {
    void refreshRuntimeCatalog(epoch);
    try {
      const [conversationData, presetData] = await Promise.all([
        api.conversations(),
        api.presets().catch(() => [] as WorkflowPreset[]),
      ]);
      if (!isCurrent(epoch)) return;
      setConversations(conversationData);
      workflowPresetsRef.current = presetData;
      setWorkflowPresets(presetData);
      if (presetData[0]) {
        setSelectedPresetId(presetData[0].id);
        setWorkflowText(serializeWorkflow(presetData[0].graph));
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
    const data = await api.conversations(query);
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
      setOpenSteps({});
    }
    if (window.innerWidth <= 900) setRailOpen(false);

    const data = await api.conversation(id);
    if (!isCurrent(epoch)) return;
    setConversation(data);
    setSetupOpen(false);
    setStuckToBottom(true);
    if (streamRef.current) streamRef.current.scrollTop = 0;
    localStorage.setItem("conclave.conversationId", id);

    if (data.lastRunId) {
      const run = await api.run(data.lastRunId);
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
      const run = await api.run(runId);
      if (!isCurrent(epoch)) return;
      adoptRun(run);
      setActiveRunId(run.id);
      localStorage.setItem("conclave.activeRunId", run.id);
      localStorage.setItem("conclave.conversationId", run.conversationId);
      const thread = await api.conversation(run.conversationId);
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
      setStuckToBottom(true);
      const attached = await consumeRun(run.id, epoch);
      if (attached && isCurrent(epoch)) await refreshConversation(run.conversationId, epoch);
    } finally {
      if (isCurrent(epoch)) setLoading(false);
    }
  }

  async function refreshConversation(id: string, epoch?: number) {
    const data = await api.conversation(id);
    if (epoch !== undefined && !isCurrent(epoch)) return;
    setConversation(data);
    await refreshConversations(epoch);
  }

  function newConversation() {
    beginViewOperation();
    if (streamRef.current) streamRef.current.scrollTop = 0;
    setConversation(null);
    setSetupOpen(true);
    setActiveRunId(null);
    setResumeRunId(null);
    setResult(null);
    setLiveSteps([]);
    setCompletedStepIds([]);
    setOpenSteps({});
    setRunUsage(freshUsage());
    setRunStartedAt(null);
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
    if (window.innerWidth <= 900) setRailOpen(false);
    requestAnimationFrame(() => promptRef.current?.focus());
  }

  function selectMode(nextMode: OrchestrationMode) {
    setMode(nextMode);
    setSetupOpen(true);
    if (nextMode === "single") {
      setSynthesizerKey("");
      setSelected(current => {
        const model = current[0] ?? (models[0] ? modelKey(models[0]) : undefined);
        return model ? [model] : [];
      });
      return;
    }

    const minimum = nextMode === "custom"
      ? requiredParticipants(parseWorkflow(workflowText).graph)
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

  /* ------------------------------------------------------- run streaming */
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
      setLiveSteps(current => (current.some(step => step.id === streamEvent.stepId)
        ? current
        : [...current, {
            id: streamEvent.stepId,
            kind: streamEvent.kind,
            model: streamEvent.model,
            content: "",
            dependsOn: streamEvent.dependsOn,
            final: streamEvent.final,
          }]));
      setAnnouncement(`${streamEvent.model.label} started ${streamEvent.kind}`);
      return;
    }

    if (streamEvent.type === "step_retrying") {
      setCompletedStepIds(current => current.filter(id => id !== streamEvent.stepId));
      setLiveSteps(current => current.map(step => (step.id === streamEvent.stepId ? { ...step, content: "" } : step)));
      return;
    }

    if (streamEvent.type === "step_failed") {
      setCompletedStepIds(current => current.filter(id => id !== streamEvent.failure.stepId));
      setLiveSteps(current => current.filter(step => step.id !== streamEvent.failure.stepId));
      return;
    }

    if (streamEvent.type === "text_delta") {
      setLiveSteps(current => current.map(step => (step.id === streamEvent.stepId
        ? { ...step, content: step.content + streamEvent.delta }
        : step)));
      return;
    }

    if (streamEvent.type === "step_completed") {
      setLiveSteps(current => (current.some(step => step.id === streamEvent.step.id)
        ? current.map(step => (step.id === streamEvent.step.id ? streamEvent.step : step))
        : [...current, streamEvent.step]));
      setCompletedStepIds(current => (current.includes(streamEvent.step.id) ? current : [...current, streamEvent.step.id]));
      return;
    }

    if (streamEvent.type === "run_completed") {
      setResult(streamEvent.result);
      setLiveSteps(streamEvent.result.steps);
      setCompletedStepIds(streamEvent.result.steps.map(step => step.id));
      setResumeRunId(null);
      setCancelling(false);
      setAnnouncement("The run finished. The final answer is ready.");
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

    const response = await api.eventStream(runId, 0, false);
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
          const response = await api.eventStream(runId, cursor, true, controller.signal);
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
        } catch {
          if (controller.signal.aborted || !isCurrent(epoch)) return false;
        }

        if (controller.signal.aborted || !isCurrent(epoch)) return false;

        let run!: StoredRun;
        try {
          run = await api.run(runId, controller.signal);
        } catch {
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
    if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSubmit) composerRef.current?.requestSubmit();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const epoch = beginViewOperation();
    setLoading(true);
    setCancelling(false);
    setError("");
    setResumeRunId(null);
    setResult(null);
    setLiveSteps([]);
    setCompletedStepIds([]);
    setOpenSteps({});
    setRunUsage(freshUsage());
    setRunStartedAt(Date.now());
    setElapsed(0);
    setRateLimit(null);
    setInspection(null);
    setStuckToBottom(true);
    setAnnouncement(`Run started in ${modeLabel} with ${participants.length} models.`);

    try {
      const started = await api.startRun({
        conversationId: conversation?.id,
        request: {
          mode,
          prompt,
          participants,
          synthesizer: effectiveSynthesizer,
          workflow: mode === "custom" ? activeWorkflow : undefined,
          budget: { maxCalls, maxRounds },
        },
      });
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
      if (isCurrent(epoch)) setError(cause instanceof Error ? cause.message : "Orchestration failed");
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
      const run = await api.cancelRun(runId);
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
    setRunStartedAt(Date.now());
    setRateLimit(null);
    setInspection(null);
    setStuckToBottom(true);
    try {
      const resumed = await api.resumeRun(runId);
      if (!isCurrent(epoch)) return;
      setActiveRunId(resumed.runId);
      setResumeRunId(null);
      localStorage.setItem("conclave.activeRunId", resumed.runId);
      localStorage.setItem("conclave.conversationId", resumed.conversationId);
      const attached = await consumeRun(resumed.runId, epoch);
      if (attached && isCurrent(epoch)) await refreshConversation(resumed.conversationId, epoch);
    } catch (cause) {
      if (isCurrent(epoch)) setError(cause instanceof Error ? cause.message : "Could not resume run");
    } finally {
      if (isCurrent(epoch)) setLoading(false);
    }
  }

  async function refreshInspector(runId: string, epoch: number, showLoading: boolean) {
    if (showLoading && isCurrent(epoch)) setInspectorLoading(true);
    try {
      const data = await api.inspection(runId);
      if (isCurrent(epoch)) setInspection(data);
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

  /* ------------------------------------------- conversation management */
  async function renameConversation(id: string, title: string) {
    try {
      const updated = await api.renameConversation(id, title);
      setConversations(current => current.map(item => (item.id === id ? { ...item, title: updated.title } : item)));
      setConversation(current => (current?.id === id ? { ...current, title: updated.title } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename conversation");
    }
  }

  async function deleteConversation(id: string) {
    try {
      await api.deleteConversation(id);
      setConversations(current => current.filter(item => item.id !== id));
      if (conversation?.id === id) newConversation();
      setAnnouncement("Conversation deleted.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete conversation");
    }
  }

  async function exportConversation(id: string, format: ConversationExportFormat) {
    try {
      const { blob, filename } = await api.exportConversation(id, format);
      saveBlob(blob, filename);
      setAnnouncement(`Exported as ${filename}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export conversation");
    }
  }

  async function copyFinalAnswer() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.final);
      setCopied(true);
    } catch {
      setError("This browser blocked clipboard access.");
    }
  }

  /* --------------------------------------------------------- commands */
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: "new", label: "New conversation", group: "Actions", icon: "plus", keys: ["N"], run: newConversation },
      {
        id: "configure",
        label: setupOpen ? "Hide run configuration" : "Configure this run",
        group: "Actions",
        icon: "sliders",
        keys: ["C"],
        run: () => setSetupOpen(open => !open),
      },
      { id: "focus", label: "Jump to the prompt", group: "Actions", icon: "send", keys: ["/"], run: () => promptRef.current?.focus() },
      { id: "theme", label: `Switch to ${theme === "dark" ? "light" : "dark"} theme`, group: "View", icon: theme === "dark" ? "sun" : "moon", keys: ["T"], run: () => setTheme(current => (current === "dark" ? "light" : "dark")) },
      { id: "rail", label: railOpen ? "Hide conversation rail" : "Show conversation rail", group: "View", icon: "panel", keys: ["S"], run: () => setRailOpen(open => !open) },
      { id: "shortcuts", label: "Keyboard shortcuts", group: "View", icon: "keyboard", keys: ["?"], run: () => setShortcutsOpen(true) },
    ];

    if (councilSteps.length > 0) {
      list.push(
        { id: "expand", label: "Expand every council step", group: "View", icon: "layers", keys: ["E"], run: expandAllSteps },
        { id: "collapse", label: "Collapse every council step", group: "View", icon: "layers", keys: ["Shift", "E"], run: () => setOpenSteps({}) },
      );
    }
    if (activeRunId) {
      list.push({ id: "details", label: "Run details", group: "Actions", icon: "layers", keys: ["D"], run: toggleInspector });
    }
    if (loading) {
      list.push({ id: "stop", label: "Stop the active run", group: "Actions", icon: "stop", keys: ["Mod", "."], run: () => void cancelActiveRun() });
    }
    if (resumeRunId && !loading) {
      list.push({ id: "resume", label: "Resume the interrupted run", group: "Actions", icon: "restart", run: () => void resumeInterruptedRun() });
    }
    if (result) {
      list.push({ id: "copy", label: "Copy the final answer", group: "Actions", icon: "copy", run: () => void copyFinalAnswer() });
    }
    if (conversation) {
      list.push(
        { id: "export-md", label: "Export this conversation as Markdown", hint: conversation.title, group: "Actions", icon: "download", run: () => void exportConversation(conversation.id, "markdown") },
        { id: "export-json", label: "Export this conversation as JSON", hint: conversation.title, group: "Actions", icon: "download", run: () => void exportConversation(conversation.id, "json") },
      );
    }
    return list;
  }, [setupOpen, theme, railOpen, councilSteps.length, activeRunId, loading, resumeRunId, result, conversation]);

  const searchConversations = useCallback(
    (text: string, signal: AbortSignal) => api.conversations(text, signal),
    [],
  );

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const distance = distanceFromLatest(event.currentTarget);
    setStuckToBottom(Math.abs(distance) < 80);
    setLatestAbove(distance < 0);
  }, [distanceFromLatest]);

  /* ------------------------------------------------------------ render */
  const composerHint = workflowInvalid
    ? workflowState.error
    : participantShortfall
      ? `${modeLabel} needs ${neededParticipants} participants`
      : budgetShortfall
        ? `Raise the call budget to at least ${expectedCalls}`
        : loading
          ? "The run continues even if this tab disconnects"
          : `${modeLabel} · ${participants.length} model${participants.length === 1 ? "" : "s"} · ${expectedCalls} planned call${expectedCalls === 1 ? "" : "s"}`;
  const blocked = workflowInvalid || participantShortfall || budgetShortfall;

  return (
    <div className="shell" data-rail={railOpen ? "open" : "closed"}>
      <a className="skip-link" href="#prompt">Skip to the prompt</a>

      {railOpen && <div className="scrim" onClick={() => setRailOpen(false)} aria-hidden="true" />}
      <Rail
        conversations={conversations}
        activeId={conversation?.id}
        activeRunning={loading}
        query={query}
        searching={searching}
        onQueryChange={setQuery}
        onOpen={id => void loadConversation(id)}
        onNew={newConversation}
        onRename={renameConversation}
        onDelete={deleteConversation}
        onExport={(id, format) => void exportConversation(id, format)}
        searchRef={searchRef}
        providers={providers}
        providersLoading={providersLoading}
        providersError={providersError}
        limits={providerLimits}
        busy={loading}
        theme={theme}
        onToggleTheme={() => setTheme(current => (current === "dark" ? "light" : "dark"))}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onCollapse={() => setRailOpen(false)}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="workspace">
        <header className="topbar">
          {!railOpen && (
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setRailOpen(true)} aria-label="Show conversation rail">
              <Icon name="panel" />
            </button>
          )}
          <div className="topbar-title">
            <strong>{conversation?.title ?? "New conversation"}</strong>
            <span>{modeLabel}{conversation ? ` · ${conversation.messages.length} messages` : " · not started"}</span>
          </div>
          <div className="topbar-actions">
            <button type="button" className="btn btn-ghost btn-icon" onClick={() => setPaletteOpen(true)} aria-label="Open command palette" title="Command palette">
              <Icon name="search" />
            </button>
            {conversation && (
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => void exportConversation(conversation.id, "markdown")}
                aria-label="Export this conversation as Markdown"
                title="Export as Markdown"
              >
                <Icon name="download" />
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={toggleInspector}
              aria-label="Run details"
              aria-expanded={inspectorOpen}
              disabled={!activeRunId}
              title="Run details"
            >
              <Icon name="layers" />
            </button>
          </div>
        </header>

        {(loading || cancelling) && (
          <div className="runstrip" aria-label="Active run">
            <div className="runstrip-lead">
              <span className="beacon" data-state="busy" />
              <strong>{cancelling ? "Stopping…" : modeLabel}</strong>
            </div>
            <div className="runstrip-models">
              {participants.map(model => (
                <ProviderMark
                  key={modelKey(model)}
                  provider={model.provider}
                  busy={liveSteps.some(step => modelKey(step.model) === modelKey(model) && !completedStepIds.includes(step.id))}
                  size="sm"
                />
              ))}
            </div>
            <div className="runstrip-stats num">
              <span>{runUsage.callsStarted}/{maxCalls} calls</span>
              <span>{runUsage.callsCompleted} done</span>
              {runUsage.tokenReports > 0 && <span>{runUsage.inputTokens.toLocaleString()}↓ {runUsage.outputTokens.toLocaleString()}↑</span>}
              <span>{formatDuration(elapsed)}</span>
              <button type="button" className="btn btn-danger" disabled={cancelling} onClick={() => void cancelActiveRun()}>
                <Icon name="stop" size={11} /> {cancelling ? "Stopping" : "Stop"}
              </button>
            </div>
            <span className="runstrip-bar">
              <i style={{ width: `${Math.min(100, (runUsage.callsCompleted / Math.max(1, expectedCalls)) * 100)}%` }} />
            </span>
          </div>
        )}

        <div className="stream" ref={streamRef} onScroll={onScroll}>
          <div className="column">
            <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

            {setupOpen && (
              <RunSetup
                mode={mode}
                modes={modes}
                fresh={!conversation}
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
                effectiveSynthesizer={effectiveSynthesizer}
                maxCalls={maxCalls}
                onMaxCallsChange={setMaxCalls}
                maxRounds={maxRounds}
                onMaxRoundsChange={setMaxRounds}
                expectedCalls={expectedCalls}
                requiredParticipants={neededParticipants}
                loading={loading}
                workflowSlot={mode === "custom" ? (
                  <WorkflowEditor
                    graph={workflowState.draft}
                    text={workflowText}
                    error={workflowState.error}
                    presets={workflowPresets}
                    selectedPresetId={selectedPresetId}
                    participants={participants}
                    synthesizer={effectiveSynthesizer}
                    disabled={loading}
                    onPresetChange={setPreset}
                    onGraphChange={applyWorkflowGraph}
                    onTextChange={text => {
                      setWorkflowText(text);
                      setSelectedPresetId("");
                    }}
                  />
                ) : undefined}
              />
            )}

            {!setupOpen && !conversation && displayedSteps.length === 0 && !loading && (
              <section className="opening">
                <span className="eyebrow">Convene the council</span>
                <h2>Ask once. Let different minds work the problem.</h2>
                <p>
                  Compare answers, route to a specialist, red-team a draft, build consensus, or run a plan through
                  executors and review. Every step is persisted locally and stays inspectable.
                </p>
              </section>
            )}

            {priorMessages.length > 0 && (
              <section className="turns" aria-label="Conversation history">
                {priorMessages.map(message => (
                  <Turn key={message.id} role={message.role} content={message.content} />
                ))}
              </section>
            )}

            {loading && displayedSteps.length === 0 && (
              <div className="working">
                <span className="pips"><i /><i /><i /></span>
                {cancelling ? "Stopping provider work…" : "Waiting for the first provider response…"}
              </div>
            )}

            {error && (
              <div className="banner" data-tone="danger" role="alert">
                <Icon name="alert" size={14} className="banner-icon" />
                <p>{error}</p>
                {resumeRunId && !loading && (
                  <button type="button" className="btn" onClick={() => void resumeInterruptedRun()}>
                    <Icon name="restart" size={13} /> Resume run
                  </button>
                )}
              </div>
            )}

            {rateLimit && (
              <div className="banner" data-tone="warn">
                <Icon name="alert" size={14} className="banner-icon" />
                <p>Rate limit · {rateLimit.provider}/{rateLimit.model}: {rateLimit.message}</p>
              </div>
            )}

            {(result || finalStep) && (
              <section className="answer" aria-label="Final answer" ref={answerRef}>
                <div className="answer-head">
                  <span className="eyebrow">
                    {answerShows === "stopped" ? "Final answer · partial" : "Final answer"}
                  </span>
                  <span className="spacer" />
                  {answerShows === "done" && (
                    <>
                      {copied && <span className="copy-state">Copied</span>}
                      <button type="button" className="btn btn-ghost" onClick={() => void copyFinalAnswer()}>
                        <Icon name="copy" size={13} /> Copy
                      </button>
                    </>
                  )}
                  {/* Who is writing belongs in the head: the body is busy
                      streaming, and the reader should not lose the byline to it. */}
                  {answerShows === "streaming" && (
                    <span className="working" aria-live="polite">
                      <span className="pips"><i /><i /><i /></span>
                      {finalStep!.model.label} is writing…
                    </span>
                  )}
                  {/* Stopped or interrupted mid-write: what is on screen is as
                      far as the model got, and saying otherwise would be a lie
                      that never resolves. */}
                  {answerShows === "stopped" && (
                    <span className="copy-state">{finalStep!.model.label} stopped before finishing</span>
                  )}
                  {/* "written" says nothing: the answer is whole, but the run
                      has other work in flight and there is no result to copy. */}
                </div>
                <div className="answer-body">
                  <Markdown content={result ? result.final : finalStep!.content} />
                </div>
              </section>
            )}

            {result?.degraded && result.failures && result.failures.length > 0 && (
              <div className="banner" data-tone="warn">
                <Icon name="alert" size={14} className="banner-icon" />
                <p>
                  <strong>Completed with partial provider failures.</strong>{" "}
                  {result.failures.map((failure: StepFailure) => `${failure.model.label}: ${failure.message}`).join(" · ")}
                </p>
              </div>
            )}

            {!loading && resumeRunId && displayedSteps.length > 0 && (
              <p className="eyebrow">Partial output · previous attempt</p>
            )}

            <CouncilWork
              steps={councilSteps}
              loading={loading}
              inspection={inspection}
              completedStepIds={completedStepIds}
              openSteps={openSteps}
              onToggleStep={stepId => setOpenSteps(current => ({ ...current, [stepId]: !current[stepId] }))}
              onExpandAll={expandAllSteps}
              onCollapseAll={() => setOpenSteps({})}
              onInspect={toggleInspector}
            />
          </div>
        </div>

        {loading && !stuckToBottom && (
          <button
            type="button"
            className="btn jump-latest"
            onClick={() => {
              setStuckToBottom(true);
              const surface = streamRef.current;
              if (!surface) return;
              const target = surface.scrollTop + distanceFromLatest(surface);
              surface.scrollTop = Math.max(0, Math.min(target, surface.scrollHeight - surface.clientHeight));
            }}
          >
            <Icon name="down" size={13} style={latestAbove ? { transform: "rotate(180deg)" } : undefined} />
            {latestAbove ? "Jump up to the answer" : "Jump to latest"}
          </button>
        )}

        <div className="composer-wrap">
          <form className="composer" ref={composerRef} onSubmit={submit}>
            <div className="composer-config">
              <button
                type="button"
                className="config-btn"
                aria-expanded={setupOpen}
                onClick={() => setSetupOpen(open => !open)}
              >
                <Icon name="sliders" size={13} />
                <strong>{modeLabel}</strong>
                <span>
                  {participants.length} model{participants.length === 1 ? "" : "s"}
                  {modeUsesSynthesizer(mode) && effectiveSynthesizer
                    ? ` · ${effectiveSynthesizer.label} ${synthesizerRole(mode).toLowerCase()}`
                    : ""}
                </span>
                <Icon name="caret" size={12} className="chevron" />
              </button>
              <span className="spacer" />
              <span className="runstrip-models" aria-hidden="true">
                {participants.map(model => (
                  <ProviderMark key={modelKey(model)} provider={model.provider} size="sm" />
                ))}
              </span>
            </div>

            <label className="sr-only" htmlFor="prompt">Prompt for the council</label>
            <textarea
              id="prompt"
              ref={promptRef}
              value={prompt}
              rows={1}
              placeholder={conversation
                ? "Continue the conversation…"
                : mode === "custom"
                  ? "Give this workflow a task…"
                  : "Ask the council…"}
              aria-describedby="composer-hint"
              onChange={event => setPrompt(event.target.value)}
              onKeyDown={handlePromptKeyDown}
            />

            <div className="composer-foot">
              <span className="composer-hint" id="composer-hint" data-tone={blocked ? "blocked" : undefined}>
                {composerHint}
              </span>
              <span className="spacer" />
              {!loading && <Keys keys={["Enter"]} />}
              <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
                {loading ? "Running…" : "Convene"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {paletteOpen && (
        <CommandPalette
          conversations={conversations}
          modes={modes}
          mode={mode}
          commands={commands}
          onSearch={searchConversations}
          onOpenConversation={id => void loadConversation(id)}
          onSelectMode={selectMode}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {inspectorOpen && (
        <RunInspector
          inspection={inspection}
          loading={inspectorLoading}
          mode={mode}
          onClose={() => setInspectorOpen(false)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
