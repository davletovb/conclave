# Hosted Conclave and shared Seatline

Conclave can be served entirely from Cloudflare, with no server of yours to run.
The website is static, the relay is a Cloudflare Worker, and the only thing that
runs on the user's machine is the Seatline companion: a native program that
opens no listening port and makes one outbound, encrypted connection.

| Piece | Where it runs | What it does |
| --- | --- | --- |
| Conclave web app (`apps/web/dist`) | Cloudflare Pages | Orchestration, budgets, history, run inspection, cancellation and exports, all in the browser tab |
| Relay (`cloudflare/`) | Cloudflare Worker + Durable Objects | Pairs a browser with a companion and forwards encrypted frames |
| Seatline companion | The user's machine | Runs Codex, Claude, Gemini and Grok with the user's own sign-ins |

Conclave owns its app logic. History and run event logs are stored in IndexedDB
under the website's origin. The standalone Conclave server is not needed in this
mode; it remains available for local development and existing local histories.

Seatline remains provider-neutral. Its shared native companion exposes provider
status, turns and scoped sessions to multiple authorized apps. No Conclave code,
Conclave storage, or Node runtime is included in Seatline. Only provider frames
pass through the encrypted web connection.

## Deploy

1. Build the web app with `VITE_SEATLINE_RELAY=https://YOUR_RELAY pnpm --filter @conclave/web build` and deploy `apps/web/dist` to Cloudflare Pages.
2. Set your website's exact origin in `APP_ORIGINS` in `cloudflare/wrangler.jsonc` (for example `{"conclave":["https://conclave.example.com"]}`) and deploy the relay with `wrangler deploy`. The relay needs both Durable Object bindings in that file, `CHANNELS` and `LIMITERS`; without `LIMITERS` it refuses to create pairings.
3. On the user's machine, install Seatline once (`seatline-companion install`) and authorize Conclave. The website and relay must be bare `https://` origins:

```sh
seatline-companion authorize conclave codex,claude,gemini,grok https://YOUR_CONCLAVE --relay=https://YOUR_RELAY
seatline-companion pair conclave https://YOUR_RELAY https://YOUR_CONCLAVE --open
```

Keep the `pair` process running while the site is in use; it is the companion's
connection to the relay. `--open` opens your browser on a private one-shot page
that forwards to the pairing link. Users need no Node installation and no
per-app companion executable. Future web apps implement the same neutral
protocol and keep their product policy in their own code.

Which build talks to what is decided when the app is built. A build with
`VITE_SEATLINE_RELAY` uses the companion. A production build with neither that
nor `VITE_CONCLAVE_API` is the hosted app and reports that it needs a relay. A
build with `VITE_CONCLAVE_API` keeps using that standalone server.

## The connection

Pairing lasts 24 hours, is scoped to the exact origin, and uses distinct helper
and browser credentials. The encryption key is generated locally and never sent
to the relay. The link's URL fragment is cleared immediately and the secrets stay
in tab session storage. Cloudflare can observe connection timing and encrypted
sizes.

The relay is not trusted. Frames use Seatline's web protocol 2 (specified in
`companion/src/secure.rs` in the Seatline repository): AES-256-GCM, a handshake
each time the companion connects that gives both sides fresh nonces, and
sequence numbers that must increase by exactly one. A frame the relay drops,
repeats or replays ends the connection, and the next handshake starts both
counters again, so the worst a relay can do is interrupt a run. The test vectors
in `cloudflare/vectors/web-protocol-v2.json` come from Seatline and are checked
by both the browser and the Node implementations. A companion older than
protocol 2 cannot connect; the site says the companion did not answer.

The pairing link is a session credential: whoever holds it (relay id, browser
token and key) can take over the browser side of the pairing for as long as it
lasts. Keep it private, and note that browsers may keep the address, fragment
included, in local or synced history until the page has cleared it. Script
injection on the website's origin has the same reach as the link.

## Relay abuse limits

The companion cannot prove who it is when it asks for a pairing, so `/pair` is
open to anyone who can reach the relay, and every pairing creates a Durable
Object that lives 24 hours. The relay therefore limits creation to 6 pairings a
minute per client address and 60 a minute per app, answering `429` with
`retry-after`. That protects against casual abuse; for a public deployment also
add a Cloudflare rate-limiting rule for `/pair` in front of the Worker.

## What runs where, and what does not work

One browser tab owns Conclave's engine. Closing/reloading it interrupts active
runs; reopening marks persisted unfinished runs interrupted, with an explicit
resume action. Interrupted provider calls are cancelled. Requests are never
automatically resubmitted after a lost acknowledgement. History is scoped to
the browser profile and origin, not synchronized between devices, and it is the
only copy: the app asks the browser to keep it and says so when the browser
declines, so export conversations you want to keep.

The companion runs two requests per app at a time, so the app sends no more than
that and shows a waiting step as waiting rather than stalled.

## Provider readiness and preparation

Conclave owns when to check a provider and what account it accepts; Seatline owns
the readiness cache (its [readiness contract](https://github.com/davletovb/seatline/blob/0cb105e4c4d753abf8fb305d8ccedeeb64dd0ef4/docs/readiness-and-preparation.md)).

- **Readiness, not a probe per step.** The app asks `readiness` (reusable for up
  to 30 seconds, Seatline's own ceiling) and sends each turn with `send_ready`
  under it, with `check_sign_in: false`, so Seatline does not run a second
  sign-in probe inside every turn. An answer is reused here for a few seconds in
  a burst of UI requests and up to 30 seconds across the steps of a run, but
  never past the age of the evidence behind it: evidence 25 seconds old when
  Seatline answered is reused here for five more seconds, not thirty, so the two
  layers never add up to more than one window.
- **Conclave's account rule stays Conclave's.** A subscription sign-in (or Google's
  cloud account for Google) is required, from the readiness before a turn and
  again from the status the send reports as it starts; a turn that changed
  account is stopped.
- **Account and configuration changes.** Seatline fingerprints the provider's
  account and configuration files and drops what it knew when they change, and
  after a turn that fails to authenticate. The app forgets its own answer after
  any failed turn, so the next step asks again. A keyring change or a revocation
  on the server cannot be seen locally: that is bounded only by the 30-second
  window, and a turn that then fails to authenticate shows the usual sign-in
  message.
- **A send Seatline refuses before it starts.** If the evidence a send named has
  changed or lapsed (`READINESS_CHANGED`, `READINESS_EXPIRED`,
  `READINESS_UNVERIFIED`) nothing ran, so the step is repeated once from a new
  check. Any other failure is final: the turn may have started.
- **Retry means a new check.** The setup screen's Retry (after signing in, say)
  asks for a new check instead of reusing a recent one; ordinary loads reuse
  Seatline's cache. Concurrent requests for a new check share one.
- **Preparation.** Focusing the prompt, and adding a provider to the selection,
  asks Seatline to prepare the providers the run is likely to use: those of the
  chosen models and of the one that will synthesize, never all four. Seatline
  resolves the executable and checks readiness; it runs no prompt, starts no
  model turn and keeps no process warm. It is best effort and silent: at most
  every ten seconds for each provider, only while one of the companion's two
  running slots is free (so it can never hold up a run), and a failure shows
  nothing. Loading the catalogue already checks every provider, so the first
  selection is not prepared again.
- **Older companions.** A companion that predates the readiness API answers those
  methods as an unknown request (`INVALID_REQUEST`). The app then uses `status`
  and `send` with `check_sign_in: true`, as it did before, and remembers that
  until the companion reconnects (it may have been updated), so the API is tried
  again then. Once the API has answered, an invalid request from it is a real
  failure, not a reason to fall back. Seatline `dc1086582c8b98498aa48dae91c8d174bc3cfc3c`
  is the oldest revision the app is tested against; CI runs the real-companion
  round trip against it, in this fallback mode, and against
  `0cb105e4c4d753abf8fb305d8ccedeeb64dd0ef4`, which has the API.

What was measured, and what was not: `scripts/seatline-web-roundtrip.mjs` runs the
real companion helper, the encrypted protocol 2 and a stand-in relay against a
shell `codex` that records every launch. One probe served a fresh readiness, a
cached readiness, a preparation and a checked send (which ran its turn); after the
account's file changed the next cached readiness was a new check (one probe); and
a plain `send` with `check_sign_in: true`, which is what each step used to be,
probed again and ran its turn. So a step inside the window now costs its turn and
no probe, where it cost a probe each. These are launches of a stand-in provider on
one machine: **there is no live measurement of latency, quota or sign-in behaviour
for a real provider**, and the extra requests (a readiness check takes one of the
two running slots for a moment, and a relay round trip) are not timed here.

Shared web search is not available in the hosted app: it needs a Conclave server
with SearXNG behind it, and the setting says so instead of failing a run. The
scripted mock provider is not offered either, so it cannot stand in for a real
model that is not signed in; a build made with `VITE_CONCLAVE_MOCK=1` offers it,
labelled as a demo.

Subscription sign-ins and Google's cloud-account sign-in are accepted. API-key
and unknown sign-ins are refused. That check is Conclave's own: Seatline does not
inspect sign-ins. Quota telemetry is unavailable through the shared adapters;
provider limits still apply. Seatline starts a provider process for each turn:
preparation checks readiness but does not keep a model warm.

Cloudflare deployment, native publisher signing and production origin/extension
configuration are release steps. This change does not deploy or publish.
