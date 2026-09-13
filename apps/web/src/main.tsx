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
  ProviderStatus,
  RunEventRecord,
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
];

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
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<OrchestrationMode>("panel");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<OrchestrationResult | null>(null);
  const [liveSteps, setLiveSteps] = useState<OrchestrationStep[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [resumeRunId, setResumeRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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

  function beginViewOperation() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    viewEpochRef.current += 1;
    return viewEpochRef.current;
  }

  function isCurrent(epoch: number) {
    return viewEpochRef.current === epoch;
  }

  async function initialize(epoch: number) {
    try {
      const [modelData, providerData, conversationData] = await Promise.all([
        fetch(`${API}/models`).then(response => readJson<ModelRef[]>(response)),
        fetch(`${API}/providers`).then(response => readJson<ProviderStatus[]>(response)),
        fetch(`${API}/conversations`).then(response => readJson<ConversationSummary[]>(response)),
      ]);
      if (!isCurrent(epoch)) return;
      setModels(modelData);
      setProviders(providerData);
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
      setError("");
      setResult(null);
      setLiveSteps([]);
      setResumeRunId(null);
    }

    const data = await fetch(`${API}/conversations/${id}`).then(response => readJson<Conversation>(response));
    if (!isCurrent(epoch)) return;
    setConversation(data);
    localStorage.setItem("conclave.conversationId", id);

    if (data.lastRunId) {
      const run = await fetch(`${API}/runs/${data.lastRunId}`).then(response => readJson<StoredRun>(response));
      if (!isCurrent(epoch)) return;
      setActiveRunId(run.id);
      localStorage.setItem("conclave.activeRunId", run.id);
      if (run.status === "completed" && run.result) {
        setResult(run.result);
        setLiveSteps(run.result.steps);
        setResumeRunId(null);
      } else if (run.status === "running" || run.status === "queued") {
        await recoverRun(run.id, epoch);
      } else {
        setResult(run.result ?? null);
        setLiveSteps(run.result?.steps ?? []);
        setResumeRunId(run.id);
        setError(run.error ?? "This run was interrupted before it completed.");
      }
    } else {
      setActiveRunId(null);
      setResult(null);
      setLiveSteps([]);
      setResumeRunId(null);
      localStorage.removeItem("conclave.activeRunId");
    }
  }

  async function recoverRun(runId: string, existingEpoch?: number) {
    const epoch = existingEpoch ?? beginViewOperation();
    try {
      const run = await fetch(`${API}/runs/${runId}`).then(response => readJson<StoredRun>(response));
      if (!isCurrent(epoch)) return;
      setActiveRunId(run.id);
      localStorage.setItem("conclave.activeRunId", run.id);
      localStorage.setItem("conclave.conversationId", run.conversationId);
      const thread = await fetch(`${API}/conversations/${run.conversationId}`).then(response => readJson<Conversation>(response));
      if (!isCurrent(epoch)) return;
      setConversation(thread);

      if (run.status === "completed" && run.result) {
        setResult(run.result);
        setLiveSteps(run.result.steps);
        setLoading(false);
        setResumeRunId(null);
        return;
      }

      if (run.status === "failed" || run.status === "interrupted") {
        setResult(run.result ?? null);
        setLiveSteps(run.result?.steps ?? []);
        setError(run.error ?? "This run was interrupted before it completed.");
        setResumeRunId(run.id);
        setLoading(false);
        return;
      }

      setResult(null);
      setLiveSteps([]);
      setError("");
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
    setLoading(false);
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
      return;
    }

    if (streamEvent.type === "error") {
      setError(streamEvent.message);
    }
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
          // A browser/network stream can disappear while the server-owned run
          // keeps working. Fall through to persisted status inspection, then
          // reconnect from the last durable sequence cursor.
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
        if (run.status === "completed") {
          if (run.result) {
            setResult(run.result);
            setLiveSteps(run.result.steps);
          }
          setResumeRunId(null);
          return true;
        }
        if (run.status === "failed" || run.status === "interrupted") {
          setError(run.error ?? "The run stopped before completion.");
          setResumeRunId(run.id);
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
    if (!prompt.trim() || participants.length === 0 || loading) return;
    const epoch = beginViewOperation();
    setLoading(true);
    setError("");
    setResumeRunId(null);
    setResult(null);
    setLiveSteps([]);

    try {
      const started = await fetch(`${API}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: conversation?.id,
          request: { mode, prompt, participants, maxRounds: 1 },
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
      if (isCurrent(epoch)) setLoading(false);
    }
  }

  async function resumeInterruptedRun() {
    if (!resumeRunId || loading) return;
    const epoch = beginViewOperation();
    const runId = resumeRunId;
    setLoading(true);
    setError("");
    setResult(null);
    setLiveSteps([]);
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
              <p>Compare independent reasoning, run a panel, stage a debate, or send an answer through critique and revision.</p>
            </section>
          )}

          {loading && displayedSteps.length === 0 && (
            <div className="thinking"><span /> <span /> <span /> Run continues even if this tab disconnects…</div>
          )}
          {error && (
            <div className="error">
              <span>{error}</span>
              {resumeRunId && <button type="button" onClick={() => void resumeInterruptedRun()}>Resume run</button>}
            </div>
          )}

          {(displayedSteps.length > 0 || result) && (
            <section className="results">
              {result && (
                <div className="final-card">
                  <span className="eyebrow">FINAL</span>
                  <p>{result.final}</p>
                </div>
              )}
              {loading && <div className="stream-status"><span className="dot" /> Live · persisted locally</div>}
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
          <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={conversation ? "Continue the conversation…" : "Ask the council…"} rows={3} />
          <div className="composer-footer">
            <span>{conversation ? "Persistent conversation" : `${participants.length} participant${participants.length === 1 ? "" : "s"}`}</span>
            <button type="submit" disabled={loading || !prompt.trim() || participants.length === 0}>{loading ? "Running…" : "Convene"}</button>
          </div>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
