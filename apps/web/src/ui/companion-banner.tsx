import React from "react";
import type { CompanionState } from "../lib/companion";
import { Icon } from "./primitives";

type CompanionBannerProps = {
  state: CompanionState;
  /** A connect window is open and Conclave is waiting for it. */
  pairing: boolean;
  /** Why the last connect did not work. */
  error: string;
  setup: { app: string; origin: string; relay: string };
  onConnect: () => void;
  onRetry: () => void;
  onDisconnect: () => void;
};

/** Where this browser stands with Seatline, and the one thing to do about it. */
export function CompanionBanner({ state, pairing, error, setup, onConnect, onRetry, onDisconnect }: CompanionBannerProps) {
  const connect = (
    <button type="button" className="btn btn-primary" onClick={onConnect} disabled={pairing}>
      {pairing ? "Connecting…" : "Connect Seatline"}
    </button>
  );

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

  const unavailable = state.kind === "unavailable";
  return (
    <div className="banner companion" data-tone={unavailable || error || (state.kind === "unpaired" && state.message) ? "warn" : "info"} role="status">
      <Icon name={unavailable || error ? "alert" : "info"} size={14} className="banner-icon" />
      <div className="banner-body">
        {unavailable
          ? <p>{state.message}</p>
          : <p><strong>Connect Seatline</strong> to use your Codex, Claude, Gemini and Grok subscriptions from this computer.</p>}
        {state.kind === "unpaired" && state.message && <p>{state.message}</p>}
        {error && <p>{error}</p>}
        <details className="banner-help">
          <summary>Setting up Seatline for the first time?</summary>
          <p>Install Seatline once, then allow this site, in a terminal:</p>
          <pre><code>{`seatline-companion install\nseatline-companion authorize ${setup.app} codex,claude,gemini,grok ${setup.origin} --relay=${setup.relay}`}</code></pre>
          <p>Seatline then keeps running in the background and starts when you log in. Sign in to each provider's own CLI as usual.</p>
        </details>
      </div>
      <div className="banner-actions">
        {unavailable && <button type="button" className="btn" onClick={onRetry}>Retry</button>}
        {connect}
      </div>
    </div>
  );
}
