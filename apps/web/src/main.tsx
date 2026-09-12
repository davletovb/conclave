import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ModelRef, OrchestrationMode, OrchestrationResult } from "@conclave/core";
import "./styles.css";

const API = import.meta.env.VITE_CONCLAVE_API ?? "http://localhost:8787";
const modes: { id: OrchestrationMode; label: string; description: string }[] = [
  { id: "single", label: "Single", description: "One model, one answer" },
  { id: "compare", label: "Compare", description: "Independent answers side by side" },
  { id: "panel", label: "Panel", description: "Independent answers, then synthesis" },
  { id: "debate", label: "Debate", description: "Challenge positions, then judge" },
  { id: "critic-revise", label: "Critic → Revise", description: "Draft, critique, improve" },
];

function App() {
  const [models, setModels] = useState<ModelRef[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<OrchestrationMode>("panel");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<OrchestrationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`${API}/models`)
      .then(r => r.json())
      .then((data: ModelRef[]) => {
        setModels(data);
        setSelected(data.map(model => model.model));
      })
      .catch(() => setError("Could not reach the Conclave server."));
  }, []);

  const participants = useMemo(
    () => models.filter(model => selected.includes(model.model)),
    [models, selected],
  );

  function toggleModel(model: string) {
    setSelected(current => current.includes(model) ? current.filter(id => id !== model) : [...current, model]);
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
            <button key={item.id} className={mode === item.id ? "mode active" : "mode"} onClick={() => setMode(item.id)}>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </nav>
        <div className="status"><span className="dot" /> Mock runtime connected</div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">ORCHESTRATION MODE</span>
            <h2>{modes.find(item => item.id === mode)?.label}</h2>
          </div>
          <div className="model-picker">
            {models.map(model => (
              <button key={model.model} onClick={() => toggleModel(model.model)} className={selected.includes(model.model) ? "chip selected" : "chip"}>
                {model.label.replace(" (mock)", "")}
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
                    <div className="step-meta"><span>{step.model.label.replace(" (mock)", "")}</span><span>{step.kind}</span></div>
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
