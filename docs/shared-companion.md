# Hosted Conclave and shared Seatline

Conclave owns its app logic. The Cloudflare-hosted browser runs orchestration,
budgets, history, run inspection, cancellation and exports. History and run event
logs are stored in IndexedDB under the website's origin. The existing app server
remains available for standalone development and existing local histories.

Seatline remains provider-neutral. Its shared native companion exposes provider
status, turns and scoped sessions to multiple authorized apps. No Conclave code,
Conclave storage, or Node runtime is included in Seatline. Only provider frames
pass through the encrypted web connection.

Build the web app with `VITE_SEATLINE_RELAY=https://YOUR_RELAY` and deploy
`apps/web/dist` to Cloudflare Pages. Conclave's relay Worker and Durable Object
live in `cloudflare/`; set the exact website origin in `APP_ORIGINS` before
deploying. Locally authorize Conclave in Seatline:

```sh
seatline-companion authorize conclave codex,claude,gemini,grok https://YOUR_CONCLAVE --relay=https://YOUR_RELAY
seatline-companion pair conclave https://YOUR_RELAY https://YOUR_CONCLAVE --open
```

This installs/uses one shared Seatline binary. Users need no Node installation
and no per-app companion executable. Future web apps implement the same neutral
protocol and keep their product policy in their own code.

Pairing lasts 24 hours, is scoped to the exact origin, and uses distinct helper
and browser credentials. The encryption key is generated locally and never sent
to the relay. URL fragments are cleared immediately and secrets stay in tab
session storage. Cloudflare can observe connection timing and encrypted sizes.

One browser tab owns Conclave's engine. Closing/reloading it interrupts active
runs; reopening marks persisted unfinished runs interrupted, with an explicit
resume action. Interrupted provider calls are cancelled. Requests are never
automatically resubmitted after a lost acknowledgement. History is scoped to
the browser profile and origin, not synchronized between devices.

Subscription sign-ins and Google's cloud-account sign-in are accepted. API-key
and unknown sign-ins are refused. Quota telemetry is unavailable through the
shared adapters; provider limits still apply. Provider warming is unchanged.

Cloudflare deployment, native publisher signing and production origin/extension
configuration are release steps. This change does not deploy or publish.
