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
  RunUsage,
  StartRunResponse,
  StoredRun,
} from "@conclave/core";
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
];

function minimumParticipants(mode: OrchestrationMode) {
  return mode === "consensus" || mode === "judge" || mode === "router" || mode === "research-council" ? 2 : 1;
}

function plannedCalls(mode: OrchestrationMode, participantCount: number, rounds: number) {
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
    case "research-council": return Math.max(4, participantCount) + 1;
    case "planner-executor": return 1 + Math.max(participantCount - 1, 1) + 1;
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

function App() {
  const [models, setModels] = useState<ModelRef[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [providerLimits, setProviderLimits] = useState<ProviderLimitSnapshot[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<OrchestrationMode>("panel");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<OrchestrationResult | null>(null);
  const [liveSteps, setLiveSteps] = useState<OrchestrationStep[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [resumeRunId, setResumeRunId] = useState<string | null>(null);
  const [runUsage, setRunUsage] = useState<RunUsage>(freshUsage);
  const [rateLimit, setRateLimit] = useState<RateLimitNotice | null>(null);
  const [maxCalls, setMaxCalls] = useState(12);
  const [maxRounds, setMaxRounds] = useState(1);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const viewEpochRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const epoch = beginViewOperation();
    void initialize(epoch);
    return () => {
      streamAbortRef.current?.abort();
      viewEpochRef.current += 1;
    };
  }, []);

  const participants = useMemo(
    () => models.filter(model => selected.includes(modelKey(model))),
    [models, selected],
  );
  const requiredParticipants = minimumParticipants(mode);
  const participantShortfall = participants.length < requiredParticipants;
  const expectedCalls = plannedCalls(mode, participants.length, maxRounds);
  const budgetShortfall = !participantShortfall && expectedCalls > maxCalls;

  const priorMessages = useMemo(
    () => conversation?.messages.filter(
      message => !(message.runId === activeRunId && message.role === "assistant"),
    ) ?? [],
    [conversation, activeRunId],
  );

  const subscriptionProviders = providers.filter(provider => provider.id !== "mock");
  const connectedProviders = subscriptionProviders.filter(provider => provider.connected);
  const runtimeLabel = connectedProviders.length > 0
    ? `${connectedProviders.map(runtimeName).join(" · ")} connected`
    : "Subscription runtimes not connected · mocks active";
  const runtimeTitle = subscriptionProviders
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

  function adoptRun(run: StoredRun) {
    setRunUsage(run.usage ?? freshUsage());
    setRateLimit(run.rateLimit ?? null);
    setCancelling(run.status === "cancelling");
    setMode(run.request.mode);
    setSelected(run.request.participants.map(modelKey));
    setMaxCalls(run.request.budget?.maxCalls ?? 12);
    setMaxRounds(run.request.budget?.maxRounds ?? run.request.maxRounds ?? 1);
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

  async function initialize(epoch: number) {
    try {
      const [modelData, providerData, conversationData, limitData] = await Promise.all([
        fetch(`${API}/models`).then(response => readJson<ModelRef[]>(response)),
        fetch(`${API}/providers`).then(response => readJson<ProviderStatus[]>(response)),
        fetch(`${API}/conversations`).then(response => readJson<ConversationSummary[]>(response)),
        fetch(`${API}/provider-limits`)
          .then(response => readJson<ProviderLimitSnapshot[]>(response))
          .catch(() => [] as ProviderLimitSnapshot[]),
      ]);
      if (!isCurrent(epoch)) return;
      setModels(modelData);
      setProviders(providerData);
      setProviderLimits(limitData);
      setConversations(conversationData);
      setSelected(initialSelection(modelData));

      const rememberedRun = localStorage.getItem("conclave.activeRunId");
      const rememberedConversation = localStorage.getItem("conclave.conversationId");
      if (rememberedRun) {
        await recoverRun(rememberedRun, epoch);
      } else if (rememberedConversation && conversationData.some(item => item.id === rememberedConversation)) {
        await loadConversation(rememberedConversation, epoch);
      }
    } catch (cause) {
      if (isCurrent(epoch)) {
        setError(cause instanceof Error ? cause.message : "Could not reach the Conclave server.");
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
      setResumeRunId(null);
      setRunUsage(freshUsage());
      setRateLimit(null);
    }

    const data = await fetch(`${API}/conversations/${id}`).then(response => readJson<Conversation>(response));
    if (!isCurrent(epoch)) return;
    setConversation(data);
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

      if (run.status === "completed" && run.result) {
        setError("");
        setResult(run.result);
        setLiveSteps(run.result.steps);
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
    setActiveRunId(null);
    setResumeRunId(null);
    setResult(null);
    setLiveSteps([]);
    setRunUsage(freshUsage());
    setRateLimit(null);
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
      setSelected(current => {
        const model = current[0] ?? (models[0] ? modelKey(models[0]) : undefined);
        return model ? [model] : [];
      });
      return;
    }

    const minimum = minimumParticipants(nextMode);
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
    setSelected(current => current.includes(key) ? current.filter(id => id !== key) : [...current, key]);
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
      setLiveSteps(current => current.some(step => step.id === streamEvent.stepId)
        ? current
        : [...current, {
            id: streamEvent.stepId,
            kind: streamEvent.kind,
            model: streamEvent.model,
            content: "",
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
      return;
    }

    if (streamEvent.type === "run_completed") {
      setResult(streamEvent.result);
      setLiveSteps(streamEvent.result.steps);
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || participantShortfall || budgetShortfall || loading) return;
    const epoch = beginViewOperation();
    setLoading(true);
    setCancelling(false);
    setError("");
    setResumeRunId(null);
    setResult(null);
    setLiveSteps([]);
    setRunUsage(freshUsage());
    setRateLimit(null);

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
            budget: { maxCalls, maxRounds },
          },
        }),
      }).then(response => readJson<StartRunResponse>(response));
      if (!isCurrent(epoch)) return;

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
    setRunUsage(freshUsage());
    setRateLimit(null);
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

  const displayedSteps = result?.steps ?? liveSteps;
  const tokenText = runUsage.tokenReports > 0
    ? `${runUsage.inputTokens.toLocaleString()} in · ${runUsage.outputTokens.toLocaleString()} out`
    : "token telemetry unavailable";

  return (
    <main className="shell">
      <aside className="sidebar">
        <div>
          <div className="brand-mark">C</div>
          <h1>Conclave</h1>
          <p className="muted">Many models. One reasoning space.</p>
        </div>
        <button className="new-chat" onClick={newConversation}>+ New conversation</button>
        <nav className="mode-list" aria-label="Orchestration mode">
          {modes.map(item => (
            <button key={item.id} className={mode === item.id ? "mode active" : "mode"} onClick={() => selectMode(item.id)}>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </nav>
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
        <div className="status" title={runtimeTitle}><span className="dot" /> {runtimeLabel}</div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="mode-heading">
            <span className="eyebrow">ORCHESTRATION MODE</span>
            <h2>{modes.find(item => item.id === mode)?.label}</h2>
          </div>
          <label className="mobile-mode-picker">
            <span className="eyebrow">MODE</span>
            <select value={mode} onChange={event => selectMode(event.target.value as OrchestrationMode)}>
              {modes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <div className="model-picker">
            <button className="chip mobile-new-chat" onClick={newConversation}>New</button>
            {models.map(model => (
              <button key={modelKey(model)} onClick={() => toggleModel(model)} className={selected.includes(modelKey(model)) ? "chip selected" : "chip"}>
                {model.label}
              </button>
            ))}
          </div>
        </header>

        <div className="content">
          {priorMessages.length > 0 && (
            <section className="conversation-history" aria-label="Conversation history">
              {priorMessages.map(message => (
                <article key={message.id} className={`message ${message.role}`}>
                  <span className="eyebrow">{message.role === "user" ? "YOU" : "CONCLAVE"}</span>
                  <p>{message.content}</p>
                </article>
              ))}
            </section>
          )}

          {!result && !loading && displayedSteps.length === 0 && priorMessages.length === 0 && (
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

          {(displayedSteps.length > 0 || result) && (
            <section className="results">
              {result && (
                <div className="final-card">
                  <span className="eyebrow">FINAL</span>
                  <p>{result.final}</p>
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
              <div className="step-grid">
                {displayedSteps.map(step => (
                  <article className="step-card" key={step.id}>
                    <div className="step-meta"><span>{step.model.label}</span><span>{step.kind}</span></div>
                    <p>{step.content || (loading ? "Waiting for output…" : "")}</p>
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>

        <form className="composer" onSubmit={submit}>
          <div className="run-controls">
            <label>
              <span>Call budget</span>
              <input
                type="number"
                min={1}
                max={64}
                value={maxCalls}
                disabled={loading}
                onChange={event => setMaxCalls(Math.max(1, Math.min(64, Number(event.target.value) || 1)))}
              />
            </label>
            {mode === "debate" && (
              <label>
                <span>Rounds</span>
                <select value={maxRounds} disabled={loading} onChange={event => setMaxRounds(Number(event.target.value))}>
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </label>
            )}
            <span className={budgetShortfall ? "budget-estimate warning" : "budget-estimate"}>
              {expectedCalls} planned call{expectedCalls === 1 ? "" : "s"}
            </span>
          </div>
          <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={conversation ? "Continue the conversation…" : "Ask the council…"} rows={3} />
          <div className="composer-footer">
            <span>{participantShortfall
              ? `${requiredParticipants} participants required for ${modes.find(item => item.id === mode)?.label}`
              : budgetShortfall
                ? `Increase call budget to at least ${expectedCalls}`
                : conversation
                  ? "Persistent conversation"
                  : `${participants.length} participant${participants.length === 1 ? "" : "s"}`}</span>
            <div className="composer-actions">
              {loading && (
                <button className="stop-run" type="button" disabled={cancelling} onClick={() => void cancelActiveRun()}>
                  {cancelling ? "Stopping…" : "Stop"}
                </button>
              )}
              <button type="submit" disabled={loading || !prompt.trim() || participantShortfall || budgetShortfall}>
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
