import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ModelRef, OrchestrationMode, OrchestrationResult, ProviderStatus } from "@conclave/core";
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
  const subscriptionModels = models.filter(model => model.source === "subscription");
  if (subscriptionModels.length === 0) return models.map(modelKey);

  const primary = subscriptionModels.find(model => model.isDefault) ?? subscriptionModels[0];
  const mockClaude = models.find(model => model.model === "mock-claude");
  const mockGrok = models.find(model => model.model === "mock-grok");
  return [primary, mockClaude, mockGrok].filter((model): model is ModelRef => Boolean(model)).map(modelKey);
}

function App() {
  const [models, setModels] = useState<ModelRef[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<OrchestrationMode>("panel");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<OrchestrationResult | null>(null);
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

  const openaiStatus = providers.find(provider => provider.id === "openai");
  const runtimeLabel = openaiStatus?.connected
    ? `ChatGPT ${openaiStatus.planType ?? ""} connected`.replace("  ", " ")
    : "OpenAI not connected · mocks active";

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || participants.length === 0) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch(`${API}/orchestrate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, prompt, participants, maxRounds: 1 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Orchestration failed");
      setResult(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Orchestration failed");
    } finally {
      setLoading(false);
    }
  }

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
        <div className="status" title={openaiStatus?.message}><span className="dot" /> {runtimeLabel}</div>
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
          {!result && !loading && (
            <section className="hero">
              <span className="eyebrow">CONVENE THE COUNCIL</span>
              <h3>Ask once. Let different minds work the problem.</h3>
              <p>Compare independent reasoning, run a panel, stage a debate, or send an answer through critique and revision.</p>
            </section>
          )}

          {loading && <div className="thinking"><span /> <span /> <span /> Convening {participants.length} model{participants.length === 1 ? "" : "s"}…</div>}
          {error && <div className="error">{error}</div>}

          {result && (
            <section className="results">
              <div className="final-card">
                <span className="eyebrow">FINAL</span>
                <p>{result.final}</p>
              </div>
              <div className="step-grid">
                {result.steps.map(step => (
                  <article className="step-card" key={step.id}>
                    <div className="step-meta"><span>{step.model.label}</span><span>{step.kind}</span></div>
                    <p>{step.content}</p>
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
