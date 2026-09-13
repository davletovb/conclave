import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ModelRef,
  OrchestrationMode,
  OrchestrationResult,
  OrchestrationStep,
  OrchestrationStreamEvent,
  ProviderId,
  ProviderStatus,
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

function App() {
  const [models, setModels] = useState<ModelRef[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<OrchestrationMode>("panel");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<OrchestrationResult | null>(null);
  const [liveSteps, setLiveSteps] = useState<OrchestrationStep[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`${API}/models`).then(r => r.json() as Promise<ModelRef[]>),
      fetch(`${API}/providers`).then(r => r.json() as Promise<ProviderStatus[]>),
    ])
      .then(([modelData, providerData]) => {
        setModels(modelData);
        setProviders(providerData);
        setSelected(initialSelection(modelData));
      })
      .catch(() => setError("Could not reach the Conclave server."));
  }, []);

  const participants = useMemo(
    () => models.filter(model => selected.includes(modelKey(model))),
    [models, selected],
  );

  const subscriptionProviders = providers.filter(provider => provider.id !== "mock");
  const connectedProviders = subscriptionProviders.filter(provider => provider.connected);
  const runtimeLabel = connectedProviders.length > 0
    ? `${connectedProviders.map(runtimeName).join(" · ")} connected`
    : "Subscription runtimes not connected · mocks active";
  const runtimeTitle = subscriptionProviders
    .map(provider => `${runtimeName(provider)}: ${provider.message ?? (provider.connected ? "connected" : "not connected")}`)
    .join("\n");

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
      return;
    }

    if (streamEvent.type === "error") {
      setError(streamEvent.message);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || participants.length === 0) return;
    setLoading(true);
    setError("");
    setResult(null);
    setLiveSteps([]);

    try {
      const response = await fetch(`${API}/orchestrate/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, prompt, participants, maxRounds: 1 }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? "Orchestration failed");
      }
      if (!response.body) throw new Error("This browser did not expose the response stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const consumeLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        applyStreamEvent(JSON.parse(trimmed) as OrchestrationStreamEvent);
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
      setError(cause instanceof Error ? cause.message : "Orchestration failed");
    } finally {
      setLoading(false);
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
        <nav className="mode-list" aria-label="Orchestration mode">
          {modes.map(item => (
            <button key={item.id} className={mode === item.id ? "mode active" : "mode"} onClick={() => selectMode(item.id)}>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </nav>
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
            {models.map(model => (
              <button key={modelKey(model)} onClick={() => toggleModel(model)} className={selected.includes(modelKey(model)) ? "chip selected" : "chip"}>
                {model.label}
              </button>
            ))}
          </div>
        </header>

        <div className="content">
          {!result && !loading && displayedSteps.length === 0 && (
            <section className="hero">
              <span className="eyebrow">CONVENE THE COUNCIL</span>
              <h3>Ask once. Let different minds work the problem.</h3>
              <p>Compare independent reasoning, run a panel, stage a debate, or send an answer through critique and revision.</p>
            </section>
          )}

          {loading && displayedSteps.length === 0 && (
            <div className="thinking"><span /> <span /> <span /> Convening {participants.length} model{participants.length === 1 ? "" : "s"}…</div>
          )}
          {error && <div className="error">{error}</div>}

          {(displayedSteps.length > 0 || result) && (
            <section className="results">
              {result && (
                <div className="final-card">
                  <span className="eyebrow">FINAL</span>
                  <p>{result.final}</p>
                </div>
              )}
              {loading && <div className="stream-status"><span className="dot" /> Live orchestration</div>}
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
          <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Ask the council…" rows={3} />
          <div className="composer-footer">
            <span>{participants.length} participant{participants.length === 1 ? "" : "s"}</span>
            <button type="submit" disabled={loading || !prompt.trim() || participants.length === 0}>{loading ? "Running…" : "Convene"}</button>
          </div>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
