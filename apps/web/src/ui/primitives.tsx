import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ModelRef, OrchestrationMode, ProviderId } from "@conclave/core";
import { highlight } from "../lib/text";
import { renderKey } from "../lib/shortcuts";
import "./google-provider.css";

/* -------------------------------------------------------------------------- */
/* icons                                                                       */
/* -------------------------------------------------------------------------- */

const paths: Record<string, React.ReactNode> = {
  search: <><circle cx="7.5" cy="7.5" r="4.75" /><path d="m11 11 3.2 3.2" /></>,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  more: <><circle cx="4" cy="8" r=".9" fill="currentColor" /><circle cx="8" cy="8" r=".9" fill="currentColor" /><circle cx="12" cy="8" r=".9" fill="currentColor" /></>,
  chevron: <path d="m6.5 4 4 4-4 4" />,
  caret: <path d="m4 6.5 4 4 4-4" />,
  check: <path d="m3.5 8.5 3 3 6-6.5" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5" /></>,
  download: <><path d="M8 2.5v8M4.8 7.6 8 10.8l3.2-3.2" /><path d="M2.8 13.2h10.4" /></>,
  trash: <><path d="M3 4.5h10M6.4 4.5V3.2h3.2v1.3" /><path d="M4.4 4.5 5 13h6l.6-8.5" /></>,
  pencil: <><path d="M11.2 2.9 13.1 4.8 5.6 12.3 3 13l.7-2.6z" /></>,
  sliders: <><path d="M2.5 5h11M2.5 11h11" /><circle cx="6" cy="5" r="1.7" /><circle cx="10" cy="11" r="1.7" /></>,
  layers: <><path d="m8 2.4 5.5 3L8 8.4 2.5 5.4z" /><path d="m2.5 8.6 5.5 3 5.5-3" /><path d="m2.5 11.4 5.5 3 5.5-3" /></>,
  stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1.4" fill="currentColor" stroke="none" />,
  send: <path d="M8 13V3.4M4.2 7.2 8 3.4l3.8 3.8" />,
  down: <path d="M8 3v10M4.2 8.8 8 12.6l3.8-3.8" />,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1.4v1.5M8 13.1v1.5M14.6 8h-1.5M2.9 8H1.4M12.7 3.3l-1 1M4.3 11.7l-1 1M12.7 12.7l-1-1M4.3 4.3l-1-1" /></>,
  moon: <path d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6z" />,
  alert: <><path d="M8 2.8 14.2 13H1.8z" /><path d="M8 6.6v3M8 11.4v.1" /></>,
  info: <><circle cx="8" cy="8" r="6" /><path d="M8 7.4v3.4M8 5.2v.1" /></>,
  keyboard: <><rect x="1.8" y="4" width="12.4" height="8" rx="1.6" /><path d="M4.4 7h.1M7 7h.1M9.6 7h.1M11.6 7h.1M5 9.6h6" /></>,
  panel: <><rect x="2" y="3" width="12" height="10" rx="1.8" /><path d="M6.4 3v10" /></>,
  command: <path d="M6 4.6a1.6 1.6 0 1 0-1.6 1.6H11a1.6 1.6 0 1 0-1.6-1.6v6.8a1.6 1.6 0 1 0 1.6-1.6H4.4A1.6 1.6 0 1 0 6 11.4z" />,
  target: <><circle cx="8" cy="8" r="5.6" /><circle cx="8" cy="8" r="1.8" /></>,
  restart: <><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13.3 2.6v2.9h-2.9" /></>,
};

export function Icon({ name, size = 15, className, style }: {
  name: keyof typeof paths | string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name] ?? null}
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* keys                                                                        */
/* -------------------------------------------------------------------------- */

export const isApple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="kbd" aria-hidden="true">
      {keys.map((key, index) => (
        <React.Fragment key={key + index}>
          {index > 0 && <span style={{ opacity: .45 }}>+</span>}
          {renderKey(key, isApple)}
        </React.Fragment>
      ))}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* provider identity — colour is always paired with a glyph and a name          */
/* -------------------------------------------------------------------------- */

const providerName: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "xAI",
  google: "Google Gemini",
  mock: "Mock",
};

const providerGlyph: Record<ProviderId, string> = {
  openai: "◎",
  anthropic: "A",
  xai: "x",
  google: "G",
  mock: "M",
};

export function providerClass(provider: ProviderId) {
  return `p-${provider}`;
}

export function ProviderMark({ provider, busy = false, size }: { provider: ProviderId; busy?: boolean; size?: "sm" }) {
  return (
    <span
      className={`pmark ${providerClass(provider)}`}
      data-busy={busy || undefined}
      data-size={size}
      title={providerName[provider]}
    >
      <span aria-hidden="true">{providerGlyph[provider]}</span>
      <span className="sr-only">{providerName[provider]}</span>
    </span>
  );
}

export function ModelIdentity({ model, busy }: { model: ModelRef; busy?: boolean }) {
  return (
    <span className={`identity ${providerClass(model.provider)}`}>
      <ProviderMark provider={model.provider} busy={busy} size="sm" />
      <span>{model.label}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* search highlighting                                                         */
/* -------------------------------------------------------------------------- */

export function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(text, terms).map((segment, index) => (
        segment.match
          ? <mark key={index}>{segment.text}</mark>
          : <React.Fragment key={index}>{segment.text}</React.Fragment>
      ))}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* layers — modal dialog and side drawer share one accessible shell            */
/* -------------------------------------------------------------------------- */

function focusables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter(element => element.offsetParent !== null || element === document.activeElement);
}

export function Layer({
  variant,
  title,
  onClose,
  children,
  actions,
  labelledBy,
  initialFocus,
}: {
  variant: "modal" | "drawer";
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  labelledBy?: string;
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const generatedId = useId();
  const headingId = labelledBy ?? generatedId;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const target = initialFocus?.current ?? (container ? focusables(container)[0] : null);
    target?.focus();
    return () => {
      // Restore focus only when this layer still owns it. An action that runs
      // as the layer closes — "jump to the prompt", say — has deliberately
      // moved focus somewhere better, and pulling it back would undo that.
      const active = document.activeElement as HTMLElement | null;
      const ours = !active || active === document.body || container?.contains(active);
      if (ours) previous?.focus?.();
    };
  }, [initialFocus]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !containerRef.current) return;
    const items = focusables(containerRef.current);
    if (items.length === 0) return;
    const first = items[0];
    const last = items.at(-1)!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === containerRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div
        ref={containerRef}
        className={variant}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {title !== undefined && (
          <header className={variant === "modal" ? "modal-head" : "drawer-head"}>
            <h2 id={headingId}>{title}</h2>
            <span className="spacer" />
            {actions}
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label={`Close ${title}`}>
              <Icon name="close" />
            </button>
          </header>
        )}
        {children}
      </div>
    </>,
    document.body,
  );
}

/* -------------------------------------------------------------------------- */
/* popover menu                                                                */
/* -------------------------------------------------------------------------- */

export function Menu({ onClose, children, label }: { onClose: () => void; children: React.ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [onClose]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "ArrowDown"
      ? items[(index + 1) % items.length]
      : items[(index - 1 + items.length) % items.length];
    next?.focus();
  }

  return (
    <div ref={ref} className="menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* mode vocabulary                                                             */
/* -------------------------------------------------------------------------- */

export type ModeMeta = { id: OrchestrationMode; label: string; description: string };

export function modeUsesSynthesizer(mode: OrchestrationMode) {
  return ["panel", "debate", "consensus", "judge", "research-council", "planner-executor", "custom"].includes(mode);
}

export function modelKey(model: ModelRef) {
  return `${model.provider}:${model.model}`;
}

export function defaultFinalizer(mode: OrchestrationMode, participants: ModelRef[], allModels: ModelRef[] = participants) {
  const participantKeys = new Set(participants.map(modelKey));
  const independent = allModels.find(model => model.source !== "mock" && !participantKeys.has(modelKey(model)))
    ?? allModels.find(model => !participantKeys.has(modelKey(model)));
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
    case "judge":
    case "debate": return "Judge";
    case "planner-executor": return "Reviewer";
    case "research-council":
    case "panel":
    case "custom": return "Synthesizer";
    case "consensus": return "Consensus builder";
    default: return "Finalizer";
  }
}

export const stepKindLabel: Record<string, string> = {
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
