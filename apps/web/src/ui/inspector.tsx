import React from "react";
import type { OrchestrationMode, RunInspection } from "@conclave/core";
import { formatDuration, relativeTime } from "../lib/text";
import { Icon, Layer } from "./primitives";

export function RunInspector({
  inspection,
  loading,
  mode,
  onClose,
}: {
  inspection: RunInspection | null;
  loading: boolean;
  mode: OrchestrationMode;
  onClose: () => void;
}) {
  const run = inspection?.run;

  return (
    <Layer variant="drawer" title="Run details" onClose={onClose}>
      <div className="drawer-body">
        {loading && !inspection && <p style={{ color: "var(--ink-3)" }}>Reading the persisted event log…</p>}

        {run && (
          <dl className="kv">
            <dt>Mode</dt><dd>{run.request.mode}</dd>
            <dt>Status</dt><dd>{run.status}</dd>
            <dt>Attempt</dt><dd>{run.attempt}</dd>
            <dt>Calls</dt><dd>{run.usage.callsCompleted}/{run.usage.callsStarted} of {run.request.budget?.maxCalls ?? "—"}</dd>
            <dt>Tokens</dt>
            <dd>{run.usage.tokenReports > 0 ? `${run.usage.inputTokens} in / ${run.usage.outputTokens} out` : "not reported"}</dd>
            <dt>Started</dt><dd>{relativeTime(run.createdAt)}</dd>
          </dl>
        )}
        {!run && !loading && <p style={{ color: "var(--ink-3)" }}>No run has been started in this conversation yet ({mode}).</p>}

        {run?.error && (
          <div className="banner" data-tone="danger">
            <Icon name="alert" size={14} className="banner-icon" />
            <p>{run.error}</p>
          </div>
        )}

        {inspection?.attempts.map(attempt => (
          <details className="attempt" key={attempt.attempt} open={attempt.attempt === inspection.run.attempt}>
            <summary>
              <Icon name="chevron" size={12} />
              <strong>Attempt {attempt.attempt}</strong>
              <span className="pill" data-status={attempt.status}>{attempt.status}</span>
              <span className="spacer" />
              <span className="num">{formatDuration(attempt.durationMs)}</span>
              <span className="num">{attempt.usage.callsStarted} calls</span>
            </summary>
            <div className="attempt-body">
              {attempt.error && (
                <div className="banner" data-tone="danger">
                  <Icon name="alert" size={14} className="banner-icon" />
                  <p>{attempt.error}</p>
                </div>
              )}
              {attempt.rateLimit && (
                <div className="banner" data-tone="warn">
                  <Icon name="alert" size={14} className="banner-icon" />
                  <p>{attempt.rateLimit.provider}/{attempt.rateLimit.model} · {attempt.rateLimit.message}</p>
                </div>
              )}
              {attempt.steps.length === 0 && <p style={{ color: "var(--ink-3)", margin: 0 }}>No steps were recorded for this attempt.</p>}
              {attempt.steps.map(step => (
                <div className="ispect-step" key={step.id}>
                  <div className="ispect-step-top">
                    <b>{step.id}</b>
                    <span className="spacer" style={{ flex: 1 }} />
                    <span className="pill" data-status={step.status}>{step.status}</span>
                  </div>
                  <div className="ispect-step-meta num">
                    <span>{step.kind ?? "step"}</span>
                    <span>{step.model?.label ?? "model pending"}</span>
                    <span>{formatDuration(step.durationMs)}</span>
                    {step.attempts !== undefined && step.attempts > 1 && <span>{step.attempts} attempts</span>}
                    {(step.inputTokens !== undefined || step.outputTokens !== undefined) && (
                      <span>{step.inputTokens ?? 0}↓ {step.outputTokens ?? 0}↑</span>
                    )}
                  </div>
                  {step.dependsOn.length > 0 && (
                    <div className="ispect-step-meta num"><span>after → {step.dependsOn.join(" · ")}</span></div>
                  )}
                  {step.error && <p className="ispect-error">{step.error}</p>}
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </Layer>
  );
}
