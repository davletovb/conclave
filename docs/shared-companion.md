# Hosted Conclave with shared Seatline

Conclave's website can be served as static files from Cloudflare Pages. Users
install the Seatline companion once and open Conclave from its launcher. A
private pairing link connects the browser to Conclave's local app engine through
the Seatline Cloudflare relay. The engine uses stdio and opens no HTTP listener.

The shared distribution includes Node and both Conclave and TabBeam workers;
users do not install Node, Cargo or separate companion applications. Conclave
owns its orchestration, budgets, history, exports, run inspection, cancellation
and recovery. Seatline owns provider execution and shared scheduling. Existing
Conclave state at `~/.conclave` is preserved.

Build the web app with `VITE_SEATLINE_RELAY=https://YOUR_SEATLINE_RELAY` and deploy
`apps/web/dist` to Pages. Configure that exact website origin in the relay's
`APP_ORIGINS` and the installed Conclave grant. Production web builds require
this pairing transport; development keeps the existing local API mode unless
the relay environment variable is set. Local development HTTP mode remains
available with `pnpm dev`.

The worker entry point is `apps/server/dist/companion.js`. After building, run it
with Node using protocol 1 framed stdio. For development authorization and
pairing commands, see [Seatline companion setup](https://github.com/davletovb/seatline/blob/codex/shared-companion/companion/README.md).
No provider credentials enter Cloudflare or the browser. App messages are
encrypted with a locally generated pairing key; pairing secrets use the URL
fragment, are removed immediately, and remain only in the browser tab session.
The relay can observe traffic timing and encrypted frame sizes.

A website disconnection ends its subscriptions, while model runs continue in
the companion. The existing event cursor restores output when the website
reconnects. Requests whose acknowledgements were lost are surfaced for inspection
and are never automatically retried, avoiding duplicate model calls. Pairing
expires after 24 hours and can be removed with Disconnect.

Subscription and Google cloud-account sign-ins are accepted; API-key and unknown
sign-ins are refused. The shared CLI adapters cannot currently supply the
OpenAI subscription-quota telemetry offered by the standalone app-server mode;
the UI reports it unavailable. Provider limits still apply at the provider.
Provider process warming is unchanged.

The PR builds a portable shared installer. Publisher signing/notarization,
Cloudflare deployment, production origins and the final Chrome extension ID are
release configuration steps. No deployment is performed by this change.
