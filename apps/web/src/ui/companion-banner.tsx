import React, { useState } from "react";
import type { CompanionState } from "../lib/companion";
import { Icon } from "./primitives";

type CompanionBannerProps = {
  state: CompanionState;
  /** Why the last pasted link did not work. */
  error: string;
  setup: { app: string; origin: string; relay: string };
  onLink: (text: string) => void;
  onRetry: () => void;
  onDisconnect: () => void;
};

/** Where this browser stands with Seatline, and the one thing to do about it. */
export function CompanionBanner({ state, error, setup, onLink, onRetry, onDisconnect }: CompanionBannerProps) {
  const [pasted, setPasted] = useState("");

  if (state.kind === "connected" && !error) {
    return (
      <div className="banner companion" data-tone="info" role="status">
        <span className="beacon" data-state="ready" aria-hidden="true" />
        <p>Connected to Seatline on this computer.</p>
        <div className="banner-actions">
          <button type="button" className="btn btn-ghost" onClick={onDisconnect}>Disconnect</button>
        </div>
      </div>
    );
  }

  if (state.kind === "connecting" || state.kind === "waiting") {
    return (
      <div className="banner companion" data-tone="info" role="status">
        <span className="beacon" data-state="busy" aria-hidden="true" />
        <p>{state.kind === "connecting" ? "Connecting to Seatline…" : "Waiting for Seatline on this computer…"}</p>
      </div>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <div className="banner companion" data-tone="warn" role="status">
        <Icon name="alert" size={14} className="banner-icon" />
        <div className="banner-body">
          <p>{state.message}</p>
          <details className="banner-help">
            <summary>Seatline not running?</summary>
            <p>Start it, or have it start whenever you log in:</p>
            <pre><code>{"seatline-companion web\nseatline-companion autostart on"}</code></pre>
          </details>
        </div>
        <div className="banner-actions">
          <button type="button" className="btn" onClick={onRetry}>Retry</button>
        </div>
      </div>
    );
  }

  const message = state.kind === "unpaired" ? state.message : undefined;
  return (
    <div className="banner companion" data-tone={error || message ? "warn" : "info"} role="status">
      <Icon name={error ? "alert" : "info"} size={14} className="banner-icon" />
      <div className="banner-body">
        <p><strong>Link this browser to Seatline</strong> to use your Codex, Claude, Gemini and Grok subscriptions from this computer. Run this once on this computer; <code>--open</code> opens the link in your default browser, or paste it below:</p>
        <pre className="banner-command"><code>{`seatline-companion link ${setup.app} --open`}</code></pre>
        {message && <p>{message}</p>}
        {error && <p>{error}</p>}
        <form className="banner-link" onSubmit={event => { event.preventDefault(); if (pasted.trim()) onLink(pasted); }}>
          <input
            className="control"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your Seatline link"
            aria-label="Seatline link"
            value={pasted}
            onChange={event => setPasted(event.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={!pasted.trim()}>Link</button>
        </form>
        <details className="banner-help">
          <summary>Setting up Seatline for the first time?</summary>
          <p>Install Seatline and allow this site once, in a terminal. Seatline then keeps linked browsers connected in the background and starts when you log in; it opens no port on this computer.</p>
          <pre><code>{`seatline-companion install\nseatline-companion authorize ${setup.app} codex,claude,gemini,grok ${setup.origin} --relay=${setup.relay}`}</code></pre>
          <p>Sign in to each provider's own CLI as usual.</p>
        </details>
      </div>
    </div>
  );
}
