import React, { useState } from "react";
import type { OrchestrationStep, RunInspection } from "@conclave/core";
import { stepStatus } from "../lib/step-status";
import { formatDuration, previewLine } from "../lib/text";
import { Markdown } from "./markdown";
import { Icon, Keys, ProviderMark, providerClass, stepKindLabel } from "./primitives";

const CLAMP_AT = 1400;

function StepBody({ step, expanded }: { step: OrchestrationStep; expanded: boolean }) {
  // Long outputs are clamped so one verbose model cannot bury the rest of the
  // council. The full text is always one click away.
  const [full, setFull] = useState(false);
  const long = step.content.length > CLAMP_AT;
  const clamped = long && !full;

  return (
    <div className="step-body" hidden={!expanded}>
      {step.dependsOn && step.dependsOn.length > 0 && (
        <div className="step-lineage">
          <span className="eyebrow" style={{ letterSpacing: ".1em" }}>after</span>
          {step.dependsOn.map(dependency => <span className="tag" key={dependency}>{dependency}</span>)}
        </div>
      )}
      {step.content
        ? (
          <>
            <div className={clamped ? "clamp" : undefined}>
              <Markdown content={step.content} />
            </div>
            {long && (
              <button type="button" className="clamp-toggle" onClick={() => setFull(value => !value)}>
                {full ? "Show less" : `Show full output (${Math.round(step.content.length / 100) / 10}k characters)`}
              </button>
            )}
          </>
        )
        : <p style={{ margin: 0, color: "var(--ink-4)" }}>Waiting for the first tokens…</p>}
    </div>
  );
}

export function CouncilWork({
  steps,
  loading,
  inspection,
  completedStepIds,
  openSteps,
  onToggleStep,
  onExpandAll,
  onCollapseAll,
  onInspect,
}: {
  steps: OrchestrationStep[];
  loading: boolean;
  inspection: RunInspection | null;
  completedStepIds: string[];
  openSteps: Record<string, boolean>;
  onToggleStep: (stepId: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onInspect: () => void;
}) {
  if (steps.length === 0) return null;

  const currentAttempt = inspection?.attempts.find(attempt => attempt.attempt === inspection.run.attempt);
  const metaById = new Map(currentAttempt?.steps.map(step => [step.id, step]) ?? []);
  const openCount = steps.filter(step => openSteps[step.id]).length;

  return (
    <section className="council" aria-label="Council work">
      <div className="council-head">
        <span className="eyebrow">Council work</span>
        <span className="num" style={{ color: "var(--ink-4)" }}>{steps.length} step{steps.length === 1 ? "" : "s"}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          onClick={openCount === steps.length ? onCollapseAll : onExpandAll}
        >
          {openCount === steps.length ? "Collapse all" : "Expand all"}
          <Keys keys={openCount === steps.length ? ["Shift", "E"] : ["E"]} />
        </button>
        <button type="button" className="btn btn-ghost" onClick={onInspect}>
          <Icon name="layers" size={13} /> Run details
        </button>
      </div>

      {steps.map(step => {
        const meta = metaById.get(step.id);
        const status = stepStatus(step, meta, completedStepIds, loading);
        const expanded = Boolean(openSteps[step.id]);
        const busy = status === "working" || status === "streaming";
        const preview = previewLine(step.content);

        return (
          <article className={`step ${providerClass(step.model.provider)}`} key={step.id} data-open={expanded}>
            <h3 style={{ margin: 0 }}>
              <button
                type="button"
                className="step-head"
                aria-expanded={expanded}
                onClick={() => onToggleStep(step.id)}
              >
                <Icon name="chevron" size={13} className="chevron" />
                <ProviderMark provider={step.model.provider} busy={busy} />
                <span className="step-id">
                  <b>{step.model.label}</b>
                  <span>{stepKindLabel[step.kind] ?? step.kind} · {step.id}</span>
                </span>
                <span className="step-tail">
                  {meta?.attempts !== undefined && meta.attempts > 1 && <span className="num">retry {meta.attempts - 1}</span>}
                  {meta?.durationMs !== undefined && <span className="num">{formatDuration(meta.durationMs)}</span>}
                  {(meta?.inputTokens !== undefined || meta?.outputTokens !== undefined) && (
                    <span className="num">{meta?.inputTokens ?? 0}↓ {meta?.outputTokens ?? 0}↑</span>
                  )}
                  <span className="pill" data-status={status}>{status}</span>
                </span>
              </button>
            </h3>
            {!expanded && preview && <p className="step-preview">{preview}</p>}
            <StepBody step={step} expanded={expanded} />
          </article>
        );
      })}
    </section>
  );
}
