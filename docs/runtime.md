# Runtime and architecture

This document covers Conclave's local runtime model: persistent runs, event streaming, budgets, retries, cancellation, storage, API endpoints, and the server/browser boundary.

## Repository layout

```text
apps/
  web/       React + Vite interface
    src/lib/ pure UI/application logic
    src/ui/  reading surface, rail, setup, workflow editor, palette
  server/    Fastify runtime, persistence, search, providers, orchestration
packages/
  core/      shared provider, workflow, event, and orchestration contracts
docs/        focused technical documentation
```

The architecture is provider-agnostic. Provider runtimes sit behind shared contracts so orchestration modes and the web UI do not need provider-specific execution logic.

## Browser/server boundary

The browser never launches or authenticates provider runtimes directly.

The local Fastify server owns:

- provider status and model discovery;
- provider child processes;
- orchestration;
- shared web-search resolution;
- persistent conversations and runs;
- event logs;
- retries and stall detection;
- cancellation;
- usage and rate-limit metadata;
- run inspection.

The web app consumes normalized server APIs and event streams.

## Persistent runs

A run is owned by the server, not by one browser request.

This allows the browser to refresh, close, or reconnect without automatically cancelling model work already in progress. The client can reconnect to the run event log and replay events after the last sequence number it observed.

If the Conclave server itself stops during a run, startup reconciles already-persisted terminal events first. Only genuinely unfinished work is marked `interrupted` and offered for a new attempt in the same conversation.

Cancelled, failed, or interrupted attempts retain already-persisted partial output.

## Normalized event protocol

Provider-specific output is mapped into a common event stream used by the run manager and web UI.

Events include run and step lifecycle information such as:

- `run_started`
- `step_started`
- `text_delta`
- usage/tool/citation metadata when available
- retry/failure events
- `step_completed`
- `run_completed`
- `error`

Providers with native chunk streaming emit incremental `text_delta` events. A provider without native chunk streaming can fall back to one complete text delta while still satisfying the same orchestration contract.

The finalizing step is explicitly marked server-side for modes that have one. This prevents the web UI from having to infer which council step produced the final answer and avoids showing the same output twice.

## Call budgets

Every persistent attempt has a server-enforced model-call budget.

The default budget is **12 model calls per attempt**. The UI can select another value up to the server hard ceiling of **64**.

Before the first provider call begins, Conclave computes the full planned call count for the selected built-in orchestration mode and rejects a run that cannot fit inside its budget.

Debate has an additional hard bound of **1–3 critique rounds**.

Custom workflows are validated against the run budget before execution as well.

The UI shows planned calls before submission and live calls-started / calls-completed telemetry while a run is active.

## Cancellation

The Stop control propagates cancellation into the active local provider runtime rather than merely disconnecting the browser.

Current provider behavior:

- OpenAI Codex — `turn/interrupt`
- Claude Code — terminate the active non-interactive Claude child process
- Grok Build — close that call's dedicated ACP process
- Antigravity CLI — terminate the dedicated `agy` process group, with forced-kill fallback when needed

After cancellation, already-persisted partial output remains available and the run can be resumed as a new attempt.

## Retries and partial failures

Conclave uses a bounded retry policy rather than unbounded automatic retries.

A provider step that fails for a transient transport/runtime reason can receive one retry when model-call budget headroom remains.

Parallel orchestration modes can preserve successful sibling outputs when one provider fails. Modes that can still produce a useful degraded result do so explicitly rather than discarding all completed work or pretending a missing synthesis succeeded.

If a custom-workflow branch fails, Conclave records the originating failed step, aborts and settles remaining in-flight sibling branches as required by the workflow failure semantics, and distinguishes those aborted siblings in inspection data.

## Stall watchdog

Each provider step has an inactivity watchdog.

By default, a call that produces no provider progress event for **180 seconds** is treated as stalled. The local runtime call is aborted, and the step becomes eligible for the same single bounded retry used for transient transport failures when budget remains.

Any provider progress event resets the inactivity timer, so slow calls can continue as long as they are still producing observable progress.

Configure the watchdog with:

```bash
export CONCLAVE_STEP_STALL_TIMEOUT_MS=180000
```

The value must be a positive integer of at least 10 milliseconds.

## Shared web-search lifecycle

When Shared web search is enabled, search happens before subscription-backed model execution.

The resulting evidence packet is persisted inside the run request and reused on resume. A resumed attempt therefore reasons over the same retrieved material rather than silently searching a newer web.

If search is unavailable, times out, or yields no usable evidence, the run fails before provider model calls begin.

See [Shared web search](web-search.md) for the search-specific boundary.

## Custom workflow execution

Custom workflows are first-class dependency graphs.

A graph contains:

- stable node IDs;
- step kinds;
- participant/synthesizer selectors;
- dependency lists;
- prompt templates;
- one explicit output node.

The server validates:

- participant indexes;
- dependency references;
- cycles;
- supported step kinds;
- output reachability;
- that every node contributes to the declared output;
- run call budget.

A node starts as soon as its own dependencies are complete rather than waiting for unrelated branches, so independent parts of the graph can execute concurrently.

Prompt interpolation is single-pass. Placeholder-like text that appears inside user input or model output remains literal and cannot become new workflow syntax.

Supported placeholders are:

```text
{{prompt}}
{{dependencies}}
{{dep.<nodeId>}}
```

## Run inspection

The Run Inspector reconstructs execution from durable run/event data.

It exposes:

- attempts;
- current and terminal status;
- duration;
- call counts;
- token usage where providers report it;
- errors and rate-limit metadata;
- step kind/model/status/timing;
- retry and failure details;
- dependency lineage.

The inspector refreshes while a run is active and the web app guards against stale responses when the user changes conversations.

## Local persistence

Default storage location:

```text
~/.conclave/
  state.json
  runs/<run-id>.ndjson
```

Use another directory with:

```bash
export CONCLAVE_DATA_DIR=/path/to/conclave-data
```

On macOS/Linux, Conclave creates or tightens local data directories to owner-only `0700` permissions and state/event files to owner-only `0600`, including previously persisted files discovered at startup.

## Local network boundary

By default, the server binds to:

```text
127.0.0.1
```

The development browser CORS allowlist is limited to:

```text
http://localhost:5173
http://127.0.0.1:5173
```

Override the bind address with:

```bash
export CONCLAVE_HOST=...
```

Provide an explicit comma-separated browser-origin allowlist with:

```bash
export CONCLAVE_WEB_ORIGIN=...
```

The web app can point at another Conclave server URL with:

```bash
export VITE_CONCLAVE_API=...
```

Exposing the server beyond the local machine is an explicit deployment/security decision and is not Conclave's default operating mode.

## Persistent runtime API

Core endpoints include:

```text
GET    /health
GET    /providers
GET    /models
GET    /provider-limits

GET    /conversations?q=<query>
GET    /conversations/:id
PATCH  /conversations/:id
DELETE /conversations/:id
GET    /conversations/:id/export?format=markdown|json

GET    /workflow-presets

POST   /runs
GET    /runs/:id
GET    /runs/:id/inspection
GET    /runs/:id/events?after=<seq>&follow=1
POST   /runs/:id/cancel
POST   /runs/:id/resume
```

Conversation search covers titles and message bodies. Quoted phrases are matched verbatim, and results can include the excerpt that matched.

Deleting a conversation also removes its runs and event logs, but deletion is refused while that conversation is owned by a genuinely live run. Run/deletion ownership is synchronized so terminal cleanup cannot race conversation deletion or a new run start.

The earlier synchronous orchestration endpoints remain available for compatibility, but the web app uses persistent runs.

## Subscription usage and telemetry

The web interface displays model-call progress against the attempt budget. Token counts are shown when the underlying runtime reports them.

Token telemetry is best-effort because the four local subscription runtimes expose different levels of information, and interrupted calls may not emit a final usage update.

Conclave exposes structured ChatGPT subscription-window usage when Codex makes that data available. For runtimes that do not expose a stable structured subscription-limit snapshot, the UI reports that snapshot as unavailable rather than inventing an estimate.

Rate-limit and quota errors returned during execution are normalized and persisted with the affected run.

## Verification

Project verification commands:

```bash
pnpm typecheck
pnpm test
pnpm build
```

GitHub Actions runs the same checks on pull requests.
