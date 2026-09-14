import React from "react";
import type { ModelRef, OrchestrationMode } from "@conclave/core";
import {
  Icon,
  ModelIdentity,
  type ModeMeta,
  ProviderMark,
  defaultFinalizer,
  modeRole,
  modeUsesSynthesizer,
  modelKey,
  providerClass,
  synthesizerRole,
} from "./primitives";

const primaryModes: OrchestrationMode[] = [
  "single",
  "panel",
  "compare",
  "research-council",
  "critic-revise",
  "red-team",
];

const moreModes: OrchestrationMode[] = [
  "debate",
  "judge",
  "consensus",
  "planner-executor",
  "router",
  "custom",
];

type SetupProps = {
  mode: OrchestrationMode;
  modes: ModeMeta[];
  fresh: boolean;
  onModeChange: (mode: OrchestrationMode) => void;
  models: ModelRef[];
  modelsLoading: boolean;
  modelsError: string;
  onRetryModels: () => void;
  selectedKeys: string[];
  participants: ModelRef[];
  onToggleModel: (model: ModelRef) => void;
  synthesizerKey: string;
  onSynthesizerChange: (key: string) => void;
  effectiveSynthesizer?: ModelRef;
  maxCalls: number;
  onMaxCallsChange: (value: number) => void;
  maxRounds: number;
  onMaxRoundsChange: (value: number) => void;
  expectedCalls: number;
  requiredParticipants: number;
  loading: boolean;
  workflowSlot?: React.ReactNode;
};

export function RunSetup(props: SetupProps) {
  const {
    mode, modes, fresh, onModeChange, models, modelsLoading, modelsError, onRetryModels,
    selectedKeys, participants, onToggleModel, synthesizerKey, onSynthesizerChange, effectiveSynthesizer,
    maxCalls, onMaxCallsChange, maxRounds, onMaxRoundsChange, expectedCalls, requiredParticipants,
    loading, workflowSlot,
  } = props;
  const [webSearchEnabled, setWebSearchEnabled] = React.useState(
    () => localStorage.getItem("conclave.webSearch") === "shared",
  );

  const meta = (id: OrchestrationMode) => modes.find(item => item.id === id)!;
  const fallbackFinalizer = defaultFinalizer(mode, participants, models);
  const shortfall = participants.length < requiredParticipants;
  const overBudget = expectedCalls > maxCalls;

  const modeButton = (id: OrchestrationMode) => (
    <button
      type="button"
      key={id}
      className="mode"
      aria-pressed={mode === id}
      disabled={loading}
      onClick={() => onModeChange(id)}
    >
      <strong>{meta(id).label}</strong>
      <span>{meta(id).description}</span>
    </button>
  );

  const toggleWebSearch = () => {
    const next = !webSearchEnabled;
    setWebSearchEnabled(next);
    if (next) localStorage.setItem("conclave.webSearch", "shared");
    else localStorage.removeItem("conclave.webSearch");
  };

  return (
    <section className="setup" aria-label="Run configuration">
      <header className="setup-head">
        <div>
          <span className="eyebrow">{fresh ? "New conversation" : "Next turn"}</span>
          <h3>{fresh ? "How should the council work this problem?" : "Adjust the council for the next message"}</h3>
        </div>
        <span className="num" style={{ color: overBudget ? "var(--warn)" : "var(--ink-3)" }}>
          {expectedCalls} of {maxCalls} calls
        </span>
      </header>

      <div className="section">
        <div className="modes">{primaryModes.map(modeButton)}</div>
        <details className="disclosure" open={moreModes.includes(mode)}>
          <summary>
            <Icon name="chevron" size={12} className="chevron" />
            More patterns
          </summary>
          <div className="disclosure-body">
            <div className="modes">{moreModes.map(modeButton)}</div>
          </div>
        </details>
      </div>

      {workflowSlot}

      <div className="section">
        <header>
          <span className="eyebrow">Participants</span>
          <span className="num" style={{ color: shortfall ? "var(--warn)" : "var(--ink-4)" }}>
            {participants.length}/{requiredParticipants} required
          </span>
        </header>

        {models.length === 0 && (
          <div className="notice">
            <Icon name={modelsLoading ? "info" : "alert"} size={14} />
            <span>{modelsLoading ? "Checking your subscription models…" : modelsError || "No models available from the local server."}</span>
            {!modelsLoading && <button type="button" className="btn" onClick={onRetryModels}>Retry</button>}
          </div>
        )}

        <div className="models">
          {models.map(model => {
            const selected = selectedKeys.includes(modelKey(model));
            return (
              <button
                type="button"
                key={modelKey(model)}
                className={`model-chip ${providerClass(model.provider)}`}
                aria-pressed={selected}
                disabled={loading}
                onClick={() => onToggleModel(model)}
              >
                <ProviderMark provider={model.provider} />
                <span className="model-chip-body">
                  <b>{model.label}</b>
                  <span>{model.source === "mock" ? "mock fallback" : model.model}</span>
                </span>
                <Icon name="check" size={14} className="tick" />
              </button>
            );
          })}
        </div>

        {participants.length > 0 && (
          <div className="roster">
            {participants.map((model, index) => (
              <div className="roster-row" key={modelKey(model)}>
                <span className="num">{index + 1}</span>
                <ModelIdentity model={model} />
                <span className="roster-role">{modeRole(mode, index)}</span>
              </div>
            ))}
            {modeUsesSynthesizer(mode) && effectiveSynthesizer && (
              <div className="roster-row" data-role="finalizer">
                <span className="num">→</span>
                <ModelIdentity model={effectiveSynthesizer} />
                <span className="roster-role">{synthesizerRole(mode)}</span>
              </div>
            )}
          </div>
        )}

        {modeUsesSynthesizer(mode) && participants.length > 0 && (
          <label className="field">
            <span>{synthesizerRole(mode)} — a separate finalization role, not an extra council member</span>
            <select
              className="control"
              value={models.some(model => modelKey(model) === synthesizerKey) ? synthesizerKey : ""}
              disabled={loading}
              onChange={event => onSynthesizerChange(event.target.value)}
            >
              <option value="">{fallbackFinalizer ? `Automatic · ${fallbackFinalizer.label}` : "Automatic"}</option>
              {models.map(model => (
                <option key={modelKey(model)} value={modelKey(model)}>
                  {model.label}{participants.some(participant => modelKey(participant) === modelKey(model)) ? " · participant" : " · independent"}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="section">
        <header>
          <span className="eyebrow">Web evidence</span>
          <span className="num">{webSearchEnabled ? "ON" : "OFF"}</span>
        </header>
        <button
          type="button"
          className="mode"
          aria-pressed={webSearchEnabled}
          disabled={loading}
          onClick={toggleWebSearch}
        >
          <strong>Shared web search</strong>
          <span>
            Search once before the run and give every selected model the same SearXNG evidence packet. Requires CONCLAVE_SEARXNG_URL on the server.
          </span>
        </button>
      </div>

      <details className="disclosure">
        <summary>
          <Icon name="chevron" size={12} className="chevron" />
          Run limits
        </summary>
        <div className="disclosure-body">
          <div className="field-row">
            <label className="field">
              <span>Call budget</span>
              <input
                className="control"
                type="number"
                min={1}
                max={64}
                value={maxCalls}
                disabled={loading}
                onChange={event => onMaxCallsChange(Math.max(1, Math.min(64, Number(event.target.value) || 1)))}
              />
              <small>Server ceiling 64</small>
            </label>
            {mode === "debate" && (
              <label className="field">
                <span>Critique rounds</span>
                <select
                  className="control"
                  value={maxRounds}
                  disabled={loading}
                  onChange={event => onMaxRoundsChange(Number(event.target.value))}
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
                <small>Hard limit 3</small>
              </label>
            )}
          </div>
          <p className="budget-line" data-over={overBudget}>
            <Icon name={overBudget ? "alert" : "info"} size={13} />
            {overBudget
              ? `This configuration plans ${expectedCalls} calls. Raise the budget to at least ${expectedCalls}.`
              : `Conclave refuses to start a run it cannot finish inside the budget.`}
          </p>
        </div>
      </details>
    </section>
  );
}
