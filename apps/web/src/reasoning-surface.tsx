import React from "react";
import type {
  ModelRef,
  OrchestrationMode,
  OrchestrationStep,
  RunInspection,
} from "@conclave/core";
import { Markdown } from "./markdown";

type ModeMeta = { id: OrchestrationMode; label: string; description: string };

const primaryModes: OrchestrationMode[] = [
  "single",
  "panel",
  "compare",
  "research-council",
  "critic-revise",
  "red-team",
  "debate",
  "judge",
  "consensus",
  "planner-executor",
];

const advancedModes: OrchestrationMode[] = ["router", "custom"];

export function modeUsesSynthesizer(mode: OrchestrationMode) {
  return ["panel", "debate", "consensus", "judge", "research-council", "planner-executor", "custom"].includes(mode);
}

export function defaultFinalizer(mode: OrchestrationMode, participants: ModelRef[], allModels: ModelRef[] = participants) {
  const participantKeys = new Set(participants.map(modelKey));
  const independent = allModels.find(model => !participantKeys.has(modelKey(model)));
  if (independent) return independent;
  if (participants.length === 0) return allModels[0];
  return mode === "planner-executor" ? participants.at(-1) : participants[0];
}

export function modeRole(mode: OrchestrationMode, index: number) {
  switch (mode) {
    case "single": return "Answerer";
    case "panel": return "Panelist";
    case "compare": return "Independent answer";
    case "debate": return "Debater";
    case "critic-revise": return index === 0 ? "Author" : index === 1 ? "Critic" : "Reserve";
    case "consensus": return "Council member";
    case "judge": return "Candidate";
    case "red-team": return index === 0 ? "Author" : "Red-team critic";
    case "router": return index === 0 ? "Router" : "Specialist candidate";
    case "research-council": return "Council member";
    case "planner-executor": return index === 0 ? "Planner" : "Executor";
    case "custom": return `Participant ${index + 1}`;
  }
}

export function synthesizerRole(mode: OrchestrationMode) {
  switch (mode) {
    case "judge": return "Judge";
    case "debate": return "Judge";
    case "planner-executor": return "Reviewer";
    case "research-council": return "Synthesizer";
    case "consensus": return "Consensus builder";
    case "panel": return "Synthesizer";
    case "custom": return "Synthesizer";
    default: return "Finalizer";
  }
}

function providerText(provider: ModelRef["provider"]) {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "xai") return "xAI";
  return "Mock";
}

export function ProviderMark({ provider, active = false }: { provider: ModelRef["provider"]; active?: boolean }) {
  const mark = provider === "openai" ? "◎" : provider === "anthropic" ? "A" : provider === "xai" ? "x" : "M";
  return <span className={`provider-mark provider-${provider}${active ? " active" : ""}`} aria-label={providerText(provider)} title={providerText(provider)}><span className="provider-mark-glyph">{mark}</span></span>;
}

export function ModelIdentity({ model, compact = false }: { model: ModelRef; compact?: boolean }) {
  return (
    <span className={compact ? "model-identity compact" : "model-identity"}>
      <ProviderMark provider={model.provider} />
      <span>{model.label}</span>
    </span>
  );
}

type RunSetupProps = {
  mode: OrchestrationMode;
  fresh: boolean;
  modes: ModeMeta[];
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
  maxCalls: number;
  onMaxCallsChange: (value: number) => void;
  maxRounds: number;
  onMaxRoundsChange: (value: number) => void;
  expectedCalls: number;
  loading: boolean;
};

function modelKey(model: ModelRef) {
  return `${model.provider}:${model.model}`;
}

export function RunSetup(props: RunSetupProps) {
  const {
    mode, fresh, modes, onModeChange, models, modelsLoading, modelsError, onRetryModels,
    selectedKeys, participants, onToggleModel, synthesizerKey, onSynthesizerChange, maxCalls, onMaxCallsChange,
    maxRounds, onMaxRoundsChange, expectedCalls, loading,
  } = props;
  const meta = (id: OrchestrationMode) => modes.find(item => item.id === id)!;
  const selectedSynthesizer = models.find(model => modelKey(model) === synthesizerKey);
  const defaultSynthesizer = defaultFinalizer(mode, participants, models);

  return (
    <section className="setup-surface" aria-label="Conversation setup">
      <div className="setup-intro">
        <span className="eyebrow">{fresh ? "NEW CONVERSATION" : "RUN CONFIGURATION"}</span>
        <h2>{fresh ? "How should Conclave work this problem?" : "Configure the next turn"}</h2>
        <p>{fresh ? "Choose the reasoning pattern first, then assign models to the roles that matter." : "Adjust the workflow or model roles for the next message in this conversation."}</p>
      </div>

      <div className="workflow-list">
        {primaryModes.map(id => (
          <button type="button" key={id} className={mode === id ? "workflow-option selected" : "workflow-option"} disabled={loading} onClick={() => onModeChange(id)}>
            <strong>{meta(id).label}</strong>
            <span>{meta(id).description}</span>
          </button>
        ))}
        <details className="advanced-workflows">
          <summary>More workflows</summary>
          <div className="workflow-list advanced">
            {advancedModes.map(id => (
              <button type="button" key={id} className={mode === id ? "workflow-option selected" : "workflow-option"} disabled={loading} onClick={() => onModeChange(id)}>
                <strong>{meta(id).label}</strong>
                <span>{meta(id).description}</span>
              </button>
            ))}
          </div>
        </details>
      </div>

      <div className="setup-models">
        <div className="setup-section-heading">
          <div><span className="eyebrow">MODELS</span><h3>Assign the participants</h3></div>
          <span className="setup-call-estimate">{expectedCalls} planned call{expectedCalls === 1 ? "" : "s"}</span>
        </div>
        {models.length === 0 && (
          <div className="setup-model-state">
            <span>{modelsLoading ? "Checking your subscription models…" : modelsError || "No models are available from the local server."}</span>
            {!modelsLoading && <button type="button" className="text-button" onClick={onRetryModels}>Retry</button>}
          </div>
        )}
        <div className="setup-model-grid">
          {models.map(model => {
            const selected = selectedKeys.includes(modelKey(model));
            return (
              <button type="button" className={selected ? "setup-model selected" : "setup-model"} key={modelKey(model)} disabled={loading} onClick={() => onToggleModel(model)}>
                <ModelIdentity model={model} />
                <span className="selection-state">{selected ? "Selected" : "Add"}</span>
              </button>
            );
          })}
        </div>

        {participants.length > 0 && (
          <div className="role-roster">
            {participants.map((model, index) => (
              <div className="role-row" key={modelKey(model)}>
                <span className="role-index">{index + 1}</span>
                <ModelIdentity model={model} compact />
                <span className="role-name">{modeRole(mode, index)}</span>
              </div>
            ))}
          </div>
        )}

        {modeUsesSynthesizer(mode) && participants.length > 0 && (
          <label className="synthesizer-control">
            <span><strong>{synthesizerRole(mode)}</strong><small>This is a separate finalization role, not an extra council member.</small></span>
            <select value={selectedSynthesizer ? synthesizerKey : ""} disabled={loading} onChange={event => onSynthesizerChange(event.target.value)}>
              <option value="">{defaultSynthesizer ? `Default · ${defaultSynthesizer.label}` : "Default"}</option>
              {models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.label}{participants.some(participant => modelKey(participant) === modelKey(model)) ? " · participant" : " · independent"}</option>)}
            </select>
          </label>
        )}

        <details className="advanced-run-settings">
          <summary>Run limits</summary>
          <div className="advanced-run-fields">
            <label><span>Call budget</span><input type="number" min={1} max={64} value={maxCalls} disabled={loading} onChange={event => onMaxCallsChange(Math.max(1, Math.min(64, Number(event.target.value) || 1)))} /></label>
            {mode === "debate" && <label><span>Rounds</span><select value={maxRounds} disabled={loading} onChange={event => onMaxRoundsChange(Number(event.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select></label>}
          </div>
        </details>
      </div>
    </section>
  );
}

function stepRole(step: OrchestrationStep) {
  const labels: Partial<Record<OrchestrationStep["kind"], string>> = {
    answer: "Answer",
    critique: "Critique",
    revision: "Revision",
    synthesis: "Synthesis",
    judgment: "Judgment",
    route: "Routing",
    research: "Research",
    plan: "Plan",
    execution: "Execution",
    review: "Review",
  };
  return labels[step.kind] ?? step.kind;
}

export function CouncilWork({
  steps,
  loading,
  inspection,
  completedStepIds,
  onInspect,
}: {
  steps: OrchestrationStep[];
  loading: boolean;
  inspection: RunInspection | null;
  completedStepIds: string[];
  onInspect: () => void;
}) {
  if (steps.length === 0) return null;
  const currentAttempt = inspection?.attempts.find(attempt => attempt.attempt === inspection.run.attempt);
  const meta = new Map(currentAttempt?.steps.map(step => [step.id, step]) ?? []);

  return (
    <section className="council-work">
      <div className="council-work-heading">
        <div><span className="eyebrow">COUNCIL WORK</span><span className="council-count">{steps.length} step{steps.length === 1 ? "" : "s"}</span></div>
        <button type="button" className="text-button" onClick={onInspect}>Run details</button>
      </div>
      <div className="member-lines">
        {steps.map(step => {
          const stepMeta = meta.get(step.id);
          const status = stepMeta?.status ?? (completedStepIds.includes(step.id) ? "completed" : loading ? (step.content ? "streaming" : "working") : (step.content ? "partial" : "pending"));
          return (
            <details className="member-line" key={step.id}>
              <summary>
                <span className="member-chevron">›</span>
                <ProviderMark provider={step.model.provider} active={status === "working" || status === "streaming"} />
                <span className="member-model-name">{step.model.label}</span>
                <span className="member-role">{stepRole(step)}</span>
                <span className={`member-status status-${status}`}>{status}</span>
                {stepMeta?.durationMs !== undefined && <span className="member-stat">{Math.max(1, Math.round(stepMeta.durationMs / 1000))}s</span>}
                {(stepMeta?.inputTokens !== undefined || stepMeta?.outputTokens !== undefined) && <span className="member-stat">{stepMeta?.inputTokens ?? 0} in / {stepMeta?.outputTokens ?? 0} out</span>}
              </summary>
              <div className="member-response">
                {step.dependsOn && step.dependsOn.length > 0 && <div className="member-lineage">after → {step.dependsOn.join(" · ")}</div>}
                {step.content ? <Markdown content={step.content} /> : <p className="muted">Waiting for output…</p>}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

export function RunConfigSummary({
  mode,
  modes,
  participants,
  synthesizer,
  onConfigure,
  onInspect,
  canInspect,
}: {
  mode: OrchestrationMode;
  modes: ModeMeta[];
  participants: ModelRef[];
  synthesizer?: ModelRef;
  onConfigure: () => void;
  onInspect: () => void;
  canInspect: boolean;
}) {
  const modeName = modes.find(item => item.id === mode)?.label ?? mode;
  const synth = synthesizer ?? defaultFinalizer(mode, participants);
  return (
    <div className="run-config-summary">
      <button type="button" className="config-pill" onClick={onConfigure}>
        <strong>{modeName}</strong>
        <span>{participants.length} model{participants.length === 1 ? "" : "s"}{modeUsesSynthesizer(mode) && synth ? ` · ${synth.label} ${synthesizerRole(mode).toLowerCase()}` : ""}</span>
        <span className="config-caret">⌄</span>
      </button>
      {canInspect && <button type="button" className="text-button" onClick={onInspect}>Details</button>}
    </div>
  );
}
