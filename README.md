# Conclave

Conclave is a personal multi-model reasoning environment: one interface where GPT, Claude, Grok, Gemini, and future providers can answer independently or work together through explicit orchestration workflows.

## Orchestration modes

- **Single** — one model, one answer
- **Compare** — independent answers side by side
- **Panel** — independent answers, then synthesis
- **Debate** — independent positions, bounded critique rounds, then judgment
- **Critic → Revise** — one model drafts, another critiques, the author revises
- **Consensus** — independent answers, a proposed consensus, then a separate consensus audit so disagreement is not silently erased
- **Judge** — independent candidate answers followed by one adjudication pass
- **Red Team** — one draft is attacked by the other selected models, then hardened by the original author
- **Router** — the first selected model routes the task to exactly one selected specialist instead of fanning out to everyone
- **Research Council** — selected models examine evidence, alternatives, implementation risks, and skepticism before synthesis; it does not pretend external browsing occurred
- **Planner → Executors** — the first model plans, the remaining selected models execute in parallel, and a reviewer produces the final answer
- **Custom Workflow** — run a validated dependency graph from a preset or an edited JSON workflow

The architecture is deliberately provider-agnostic so subscription-backed runtimes can be added behind adapters without changing the UI or orchestration engine. Multi-stage modes have explicit bounded stages, and Debate clamps critique rounds to 1–3.

## Repository structure

```text
apps/
  web/       React + Vite interface
    src/lib/ pure logic: keyboard model, workflow graph editing, formatting
    src/ui/  the interface: rail, setup, council work, workflow editor, palette
  server/    Fastify orchestration/runtime service
packages/
  core/      shared provider + orchestration contracts
```

The browser never talks directly to provider runtimes. The server owns provider authentication and local processes such as Codex app-server, Claude Code, Grok Build ACP, and Antigravity CLI.

## Current status

All four current providers have subscription-backed local adapters:

- OpenAI through `codex app-server` and ChatGPT sign-in
- Anthropic through Claude Code and `claude.ai` sign-in
- xAI through Grok Build ACP and cached Grok/X OAuth sign-in
- Google Gemini through the official Antigravity CLI and cached Google-account sign-in

If a runtime is missing or not authenticated, Conclave keeps that provider's mock model available so the rest of the app remains usable.

The adapters are intentionally subscription-first. Conclave refuses OpenAI API-key Codex sessions, refuses Claude Console/API-key or cloud-provider authentication, removes xAI API-key/custom-endpoint environment routes before launching Grok ACP, and uses Antigravity's cached Google-account authentication for Gemini. The Google adapter does not call Gemini model APIs directly and shadows direct Gemini/API/Vertex credential environment routes before launching `agy`.

Claude paid plans can separately enable Anthropic **usage credits**. If usage credits are enabled on the Claude account, Anthropic may use them after included subscription limits are exhausted. That is an account-level Claude setting; Conclave cannot override it.

Conclave has a normalized streaming protocol. Provider-specific deltas are mapped into orchestration events (`run_started`, `step_started`, `text_delta`, tool/citation/usage events, `step_completed`, `run_completed`, and `error`). OpenAI Codex, Grok ACP, and Antigravity CLI expose native text deltas; Claude Code uses its partial-message stream. Providers without native chunk streaming automatically fall back to one complete `text_delta`, so every adapter follows the same contract.

Conversations and run state are persisted locally. A run is owned by the server rather than by one browser request, so closing or refreshing the page does not cancel it. The browser reconnects to the run event log and replays anything it missed. If the Conclave server itself stops during a run, startup reconciles any already-persisted terminal event first; only genuinely unfinished work is marked `interrupted` and offered for a new attempt in the same conversation.

## Run controls and subscription usage

Each persistent run has a server-enforced budget. The default is **12 model calls per attempt**; the UI can choose a lower or higher cap up to the server hard ceiling of **64**. Conclave calculates the complete call count for the chosen orchestration mode before the first provider call and rejects a run that cannot fit within its budget. Debate additionally has a **1–3 round** hard limit.

The web UI shows planned calls before submission and live `calls started / calls completed` telemetry while a run is executing. Token counts are shown when the underlying runtime reports them; token reporting is best-effort because the four subscription runtimes expose different levels of telemetry and an interrupted call may not produce a final token update.

Active runs have a **Stop** control. Cancellation propagates into the current local provider runtime rather than merely disconnecting the browser:

- OpenAI Codex — `turn/interrupt`
- Claude Code — terminate that call's non-interactive Claude child process
- Grok Build — close that call's dedicated ACP process
- Antigravity CLI — terminate the dedicated `agy` process group, with SIGTERM followed by SIGKILL fallback

Cancelled attempts retain their already-persisted partial output and can be resumed as a new attempt.

Conclave exposes structured ChatGPT subscription-window usage when Codex makes `account/rateLimits/read` available. Claude Code, Grok Build ACP, and Antigravity CLI do not currently expose equivalent stable structured subscription-limit snapshots to Conclave, so the UI labels those snapshots unavailable rather than inventing estimates. Runtime rate-limit/quota errors are normalized and persisted with the affected run.

Each provider step also has an inactivity watchdog. By default, a call that produces no provider progress event for **180 seconds** is treated as stalled, its local runtime call is aborted, and the step is eligible for the same single bounded retry used for transient transport failures when call-budget headroom remains. Any provider event resets the watchdog, so long-running calls can continue as long as they are still making observable progress. Set `CONCLAVE_STEP_STALL_TIMEOUT_MS` to a positive integer of at least 10 milliseconds to tune the inactivity window for local testing or unusually slow runtimes.

## Custom workflows and run inspection

Custom Workflow mode makes orchestration a first-class graph instead of a frontend shortcut. A workflow contains stable node IDs, a step kind, a participant/synthesizer selector, an optional dependency list, a prompt template, and one explicit output node. The server validates the complete graph before the run is persisted, including participant indexes, dependency references, cycles, supported step kinds, output reachability, and the run's call budget.

Nodes whose prerequisites are satisfied can run concurrently. A dependent starts as soon as its own prerequisites finish rather than waiting for unrelated branches. Every node must contribute to the output node, so disconnected leftovers cannot consume subscription calls. If one workflow branch fails, Conclave records the originating failed step, aborts and settles the remaining in-flight workflow branches, and distinguishes those aborted siblings in the inspector.

Prompt templates support:

- `{{prompt}}` — the user's original task
- `{{dependencies}}` — all declared upstream outputs for that node
- `{{dep.<nodeId>}}` — one declared upstream output

Interpolation is single-pass: placeholder-like text contained inside user input or model output remains literal and cannot become new workflow syntax.

Conclave ships with three initial presets: **Triangulate**, **Challenge → Revise**, and **Decision Board**. The web UI can load a preset as a starting point and then edit the graph directly — add and remove nodes, rename them, change step kinds, assign participants or the synthesizer, toggle dependencies, and insert placeholders into prompt templates — with the raw JSON still available underneath. The editor validates every change against the same rules as the server and refuses a dependency that would close a cycle, so an invalid graph is caught before it costs a subscription call.

The **Run Inspector** reconstructs execution from the durable event logs. It shows current and archived attempts, status, duration, calls/tokens where available, errors/rate limits, each step's model/kind/status/timing, and dependency lineage. It refreshes while an active run is executing and ignores stale responses after the user changes conversations.

## The interface

The web app is built around a single idea: the answer is what you read, and the
machinery is what you operate. Those two registers are visually distinct —
editorial serif for the final answer, compact sans and tabular figures for
telemetry — and colour carries exactly one piece of information, which provider
is speaking, always paired with a glyph and a name so it never carries it alone.

**Conversation management.** The rail lists every conversation grouped by
recency, with rename, delete (behind an inline confirmation), and Markdown/JSON
export per conversation. Search runs on the server across message bodies, not
only titles, and each result shows the excerpt that matched.

**The command palette** (`Ctrl`/`Cmd`+`K`) is one entry point for searching
conversations, switching orchestration pattern, and running any action that has
a keyboard binding, so nothing is discoverable only by memorising a shortcut.

**Council work** is a timeline of collapsible steps. Each collapsed step shows a
live preview of its latest line; each expanded one clamps very long output
behind a "show full output" control so a single verbose model cannot bury the
rest of the council. `E` expands everything, `Shift`+`E` collapses it.

**Long runs.** While a run is live, a strip under the header shows the pattern,
which models are working, calls started/completed against the budget, token
telemetry where the runtime reports it, elapsed time, and Stop. The transcript
sticks to the newest output until you scroll away, and then offers "Jump to
latest" instead of fighting you for the scroll position.

**Workflow authoring.** Custom Workflow mode has a structured node editor: node
ID, step kind, which participant or the synthesizer runs it, its dependencies as
toggles, and its prompt template with one-click placeholder insertion. Renaming
a node rewrites its dependants and their `{{dep.<nodeId>}}` references.
Dependencies that would close a cycle are refused with an explanation rather
than failing validation later. The graph is validated on every edit, an
execution-order map shows which nodes run in parallel, and the raw JSON remains
editable underneath.

**Keyboard.** Modified chords stay live while typing (`Mod`+`K` palette,
`Mod`+`Enter` convene, `Mod`+`.` stop); bare keys act only outside text fields
(`/` prompt, `C` configure, `D` run details, `E`/`Shift`+`E` expand/collapse,
`N` new conversation, `S` rail, `T` theme, `?` help, `Esc` closes the top layer).
Press `?` for the full list.

**Accessibility.** A skip link, visible focus rings on every control, dialogs
and drawers with focus trapping and focus restoration, live-region announcements
for run progress, labelled controls throughout, and `prefers-reduced-motion`
honoured. Light and dark themes are both first-class, and the layout works down
to 390px.

## Run locally

Requirements: Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

- Web: `http://localhost:5173`
- Server: `http://localhost:8787`

Override the server URL with `VITE_CONCLAVE_API` when needed.

The server is local-only by default: it binds to `127.0.0.1`, and browser CORS is limited to `http://localhost:5173` and `http://127.0.0.1:5173`. `CONCLAVE_HOST` can override the bind address and `CONCLAVE_WEB_ORIGIN` can provide a comma-separated origin allowlist. Exposing the server beyond the local machine should be treated as an explicit deployment/security decision rather than the default personal-use setup.

By default persistent state is stored under:

```text
~/.conclave/
  state.json
  runs/<run-id>.ndjson
```

Set `CONCLAVE_DATA_DIR` to use a different local directory. On macOS/Linux, Conclave creates/tightens its data directories to owner-only `0700` and state/event files to owner-only `0600`, including existing persisted files discovered at startup.

The persistent runtime API is:

- `GET /conversations?q=<query>` — recent conversations, optionally full-text filtered across titles and message bodies (quoted `"phrases"` are matched verbatim); each hit carries the excerpt that matched
- `GET /conversations/:id` — one conversation with messages
- `PATCH /conversations/:id` — rename a conversation
- `DELETE /conversations/:id` — delete a conversation with its runs and event logs; refused while that conversation has an active run
- `GET /conversations/:id/export?format=markdown|json` — export one conversation, including the council work behind each answer
- `GET /workflow-presets` — built-in reusable custom workflow graphs
- `POST /runs` — start a background orchestration run
- `GET /runs/:id` — inspect persisted run state, budget, and usage
- `GET /runs/:id/inspection` — reconstruct attempt/step timing, usage, status, and dependency lineage
- `GET /runs/:id/events?after=<seq>&follow=1` — replay and follow the run's NDJSON event log
- `POST /runs/:id/cancel` — stop an active run/provider call
- `POST /runs/:id/resume` — restart a failed/interrupted/cancelled run as the next attempt
- `GET /provider-limits` — available structured subscription-limit snapshots

The earlier `POST /orchestrate` and `POST /orchestrate/stream` endpoints remain available for compatibility, but the web app now uses persistent runs.

## Connect your ChatGPT subscription

Conclave expects the official Codex CLI on the same machine. After installing Codex, run:

```bash
codex
```

Choose **Sign in with ChatGPT** and complete the browser login. Restart `pnpm dev` afterward. If Codex is authenticated with an API key, Conclave leaves OpenAI disconnected by design.

## Connect your Claude subscription

Conclave expects the official Claude Code CLI on the same machine. Check it with:

```bash
claude --version
```

Then authenticate through your Claude account:

```bash
claude auth login
claude auth status
```

Use the normal **claude.ai** subscription login. Do not use `claude auth login --console`, which selects Console/API usage billing. Restart `pnpm dev` after signing in.

The Claude adapter checks `claude auth status` before every model listing or generation request and only accepts `claude.ai` first-party authentication. It removes API/platform credential environment variables from child processes and runs Claude in safe, tool-free, non-persistent print mode.

Conclave currently exposes the stable Claude Code model aliases `sonnet`, `opus`, and `haiku`. Claude Code resolves those aliases to the models available to the signed-in account.

## Connect your Grok subscription

Install the official Grok Build CLI:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

Verify it and sign in:

```bash
grok version
grok login
```

Complete the browser OAuth flow using the Grok/X account associated with your subscription. For a headless or remote machine, `grok login --device-auth` uses device-code authentication.

Conclave talks to Grok through the official Agent Client Protocol transport (`grok agent stdio`). It only accepts the ACP `cached_token` authentication method and deliberately does not use `xai.api_key`. The child process also has `XAI_API_KEY`, legacy API-key variables, and custom model-endpoint environment variables removed.

The current built-in Grok Build catalog exposes **Grok 4.6** as the default and **Grok 4.5** as an additional model. Conclave mirrors those subscription-backed choices.

Restart `pnpm dev` after signing in.

## Connect your Gemini subscription

Install the official Google Antigravity CLI:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Open a new terminal (or reload your shell), verify the CLI, and start one interactive session:

```bash
agy --version
agy
```

Complete **Sign in with Google** using the Google account associated with your Gemini access/subscription. Antigravity stores that sign-in in the platform keyring; Conclave reuses the cached login and does not initiate OAuth itself. Restart `pnpm dev` after signing in.

Conclave discovers the signed-in account's current Gemini catalog with `agy models` and exposes only model IDs beginning with `gemini-`. It does not hard-code preview model names, so new or retired Gemini variants follow Antigravity's live catalog automatically. The short-lived aliases `auto`, `pro`, `flash`, and `flash-lite` from the earlier Gemini-CLI adapter are accepted only for resuming persisted runs and are mapped to the closest live Antigravity model.

For generation, Conclave runs Antigravity headlessly with `--input-format stream-json --output-format stream-json`. The prompt is sent over stdin rather than the process command line. Each call uses a fresh owner-only temporary workspace, shadows direct Gemini/API/Vertex credential environment variables, enables Antigravity's terminal sandbox, and never passes `--dangerously-skip-permissions`. Conclave instructs the model not to use tools and aborts the provider call if the event stream reports a tool step.

Antigravity still loads the user's global permission configuration from its normal home directory because that is also where its supported account/keyring integration is rooted. Avoid broad global `allow` rules if you want Conclave's Google provider to remain a text-only reasoning surface; the private workspace and sandbox reduce exposure, but Conclave does not claim to override centrally or globally managed Antigravity permissions.

Restart `pnpm dev` after signing in.

You can inspect all local provider states at:

```bash
curl http://localhost:8787/providers
```

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

GitHub Actions runs the same checks on pull requests.

## Near-term roadmap

1. ✅ OpenAI adapter via subscription-authenticated Codex runtime
2. ✅ Anthropic adapter via subscription-authenticated Claude Code runtime
3. ✅ xAI adapter via Grok Build ACP runtime
4. ✅ Google Gemini adapter via subscription-authenticated Antigravity CLI runtime
5. ✅ Normalized streaming event protocol for partial output and future tool events
6. ✅ Persistent conversations and resumable orchestration runs
7. ✅ Consensus, Judge, Red Team, Router, Research Council, and Planner/Executor modes
8. ✅ Per-run budgets, round limits, cancellation, and usage/rate-limit visibility
9. ✅ Custom workflow graph/presets and richer run inspection
10. ✅ Web-first robustness: partial-provider failure handling, step-level retry, stalled-provider recovery, reconnect/reload stress coverage, and stronger lifecycle integration tests
11. ✅ Web UI/UX: conversation management/search/export, collapsible model outputs, better long-run rendering, richer workflow authoring, keyboard shortcuts, and accessibility

Desktop/local-native packaging and an IPC transport remain intentionally deferred. The orchestration/provider core should stay transport-independent so native packaging can be added later without driving current product design.