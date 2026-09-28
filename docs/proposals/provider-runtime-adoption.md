# Proposal: adopting the shared provider runtime

**Status:** The decisions in §2 were made by the project owner on 2026-09-28. The plan is open for review, and becomes Conclave's ADR once agreed  
**Date:** 2026-09-28  
**Related:** Pervue's [provider runtime proposal][runtime-proposal], which covers the library itself  
**Evidence:** Conclave at `1379a37`, Pervue at `fc7284b`

## Summary

- **Conclave adopts the shared provider runtime for all four providers at once.** The runtime is the Rust library being extracted from Pervue. Conclave adopts it in a new Rust server, which replaces the Fastify server and keeps the same HTTP API. The web app's requests and data shapes don't change. Its only additions are a sign-in handoff and sending credentials (§4).
- **Decisions made** (§2):
  - Rewrite the server in Rust, with no go/no-go spike beforehand.
  - Use `codex exec` for OpenAI and Grok's one-shot headless mode for Grok.
  - Fix the current server's security gaps in the Rust server, rather than patching the TypeScript server.
  - The library lives in its own repository, pinned to a git revision.
- **Prerequisite.** The library must finish its Stage 2: hardened inside Pervue, extracted with all four adapters, and Pervue running on it ([runtime proposal §7][runtime-stages]). Much of the port doesn't depend on the library and can start earlier (§6).
- **The subscription-only guarantee is kept.**
  - A sign-in check that authorizes billing finishes before every model call that needs one, and never runs alongside it.
  - Caching that check is an explicit Conclave setting, off by default (§5).
- **Accepted tradeoffs:**
  - OpenAI and Grok answers arrive a message at a time instead of token by token.
  - OpenAI loses its live model list and its usage panel.
  - The TypeScript server's authentication and Host-header gaps stay open until the switch-over (§8).

## 1. Conclave today

- **Size.** The server is 5,712 lines of TypeScript plus 3,440 lines of tests. The orchestrator alone is 1,746 lines, covering 12 modes and custom workflow graphs.
- **Shared types.** The web app (React and TypeScript) shares types with the server through `packages/core`, which 15 web files import.
- **Providers.** Four adapters, each handling processes its own way. The [runtime proposal §1][runtime-conclave] compares them with Pervue's.
- **Event streams.** Events reach the browser as newline-delimited JSON over HTTP, with `after=<seq>` replay. Runs belong to the server and outlive the browser tab.
- **Storage.** Runs and conversations live in `~/.conclave/state.json` and `runs/*.ndjson`, with 0700/0600 permissions.
- **Security gaps** ([index.ts][c-index]):
  - there's no authentication, only a CORS allowlist of browser origins, so any local process can drive the API;
  - there's no Host-header check, so the server is exposed to DNS rebinding. A malicious website can rebind its domain to `127.0.0.1`, then read conversations and start runs as if it were same-origin. Recent Chrome versions block some of this, but not every browser does.
- **Per-call and per-page-load processes.**
  - `claude auth status` runs before every Claude call ([anthropic-claude.ts:235][c-claude-auth]).
  - `/providers` starts `claude auth status`, `agy models`, and a whole Grok ACP process on every request. `/models` starts similar work.

## 2. Decisions

| Decision | Choice | What it means |
|---|---|---|
| Adopt the runtime | All four providers at once | Conclave is the library's second consumer for all four execution modes |
| How | A Rust server that links the library in-process through its service API | About 4,200 lines of server code and about 2,300 lines of non-provider tests to port. The web app's types are generated from Rust |
| A go/no-go spike | None | Porting one slice end to end is still the first milestone (§6), but it isn't a decision gate |
| OpenAI | `codex exec` | No token-by-token streaming. The model picker needs a list kept by hand. The ChatGPT usage panel (`/provider-limits`) shows as unavailable. The subscription check classifies `codex login status` |
| Grok | One-shot headless mode | No token-by-token streaming. Conclave doesn't use Grok's search. Each turn gets a private `GROK_HOME`, Grok's MCP umbrellas are denied, and the `init` boundary is verified |
| Current security gaps | Fixed in the Rust server; the TypeScript server isn't patched | The gaps stay open until the switch-over (§8) |
| Where the library lives | Its own repository | Conclave pins it to a git revision, and bumps the pin deliberately |

**Alternatives considered.**
- **A sidecar.** Keep the Node server and run the library as a separate process wrapping its service API. This is the smallest change, but it needs binary distribution, a second protocol, and a separate failure mode. It remains the fallback if the port stalls (§7).
- **Keeping the TypeScript adapters.** This duplicates the hardest process code, and Node can't reproduce some of the library's guarantees. For example, it can't kill a process group before reaping the child.
- **A Node addon or a C ABI.** These bring FFI, `unsafe` binding code, and in-process crashes into the Node server.
- **Codex app-server and Grok ACP clients of Conclave's own.** These would keep token-by-token streaming, but they're more work and would keep two Conclave-only adapters outside the shared library.

## 3. Before the port

- **The library's Stage 2 must be done** before any provider runs through it. The library's CI, including the hostile-process matrix and the fake providers, is green, and Pervue's full test suite passes against it.
- **Record the HTTP contract** from the current server, running on the mock provider. It's the parity test for the Rust server.
  - **Every endpoint:**
    - status codes;
    - response headers, including `Content-Type` and `Content-Disposition` for exports;
    - CORS responses, for allowed and denied origins and preflights;
    - the request-body limit: Fastify's default of 1 MiB, answered with 413;
    - how invalid bodies and unknown fields are handled.
  - **Event streams:**
    - NDJSON framing and event order;
    - reconnecting with `after=<seq>`;
    - each event flushed promptly rather than buffered, measured with timestamps;
    - cancelling a run while its stream is open;
    - what happens when the client disconnects.
  - **Every orchestration mode:** the event sequences, the errors, and the files stored under the data directory.

  - **Configuration:** run the recording once more with `CONCLAVE_DATA_DIR` pointing at a non-default directory.

  Authentication and Host checks aren't in today's server, so the recording can't cover them. They're specified and tested as new behavior in the Rust server (§4). The 1 MiB body limit is in today's server, so it's recorded. Any deliberate change to it is documented.

## 4. The Rust server

**Same functionality.** The web app keeps talking to the same HTTP API.

| Today (TypeScript) | Rust server |
|---|---|
| Fastify routes and CORS | axum plus tower-http, with the same routes and JSON shapes |
| Newline-delimited JSON event streams with `after=<seq>` replay | A streamed response body: same format, same replay, flushed per event |
| Orchestrator (12 modes, workflow graphs, budgets, retries) | tokio tasks for parallel steps, plus cancellation tokens |
| Stall watchdog plus 180 s per-adapter timeouts | The library's idle and absolute limits. `CONCLAVE_STEP_STALL_TIMEOUT_MS` and `CONCLAVE_*_TURN_TIMEOUT_MS` map onto them |
| Retry decisions by regex on error text | The library's `retryable` flag and reason codes |
| `state.json` and `runs/*.ndjson` under `~/.conclave`, or under `CONCLAVE_DATA_DIR` when it's set, with 0700/0600 permissions | Same files in the same place, so existing data still loads |
| SearXNG client | reqwest, with the search-result sanitizer shared with Pervue |
| Four provider adapters | The library's four adapters, through its service API |
| Web app served by Vite in development | The server also serves the built web app, so users need neither Node nor pnpm |

**Configuration.** Every variable the current server reads keeps working, or is deliberately retired with a startup warning:
- **Same meaning:** `PORT`, `CONCLAVE_HOST`, `CONCLAVE_WEB_ORIGIN`, `CONCLAVE_DATA_DIR`, `CONCLAVE_SEARXNG_URL`, and `CONCLAVE_SEARCH_TIMEOUT_MS`. The web build's `VITE_CONCLAVE_API` also stays.
- **Mapped onto the library:**
  - `CONCLAVE_STEP_STALL_TIMEOUT_MS` becomes the idle limit.
  - `CONCLAVE_CLAUDE_TURN_TIMEOUT_MS`, `CONCLAVE_CODEX_TURN_TIMEOUT_MS`, `CONCLAVE_GROK_TURN_TIMEOUT_MS`, and `CONCLAVE_ANTIGRAVITY_TURN_TIMEOUT_MS` become each provider's absolute limit.
  - `CONCLAVE_CODEX_BIN` becomes the library's explicit executable override for Codex, read from startup configuration.
- **Retired,** because they belong to modes Conclave is leaving: `CONCLAVE_CODEX_RPC_TIMEOUT_MS` (Codex app-server) and `CONCLAVE_GROK_FIRST_CHUNK_WAIT_MS` (Grok ACP).

**Web app types.**
- The server's Rust types become the source of truth, and the TypeScript types in `packages/core` are generated from them, for example with ts-rs.
- CI fails if the generated types differ from the committed ones.

**Security.**
- From the library, for every provider:
  - prompts that never go on the command line;
  - bounded memory;
  - process-group kill with escalation;
  - an allowlisted environment;
  - private workspaces and absolute executable paths;
  - per-turn cleanup;
  - strict `init` checks.
- New in the server:
  - a per-install token, with the handoff below;
  - a Host-header allowlist on every request, static files included;
  - request bodies parsed into typed structs.
- Kept from today: the 1 MiB request-body limit and its 413 response, now set explicitly rather than inherited from Fastify's default.

**Token handoff.** The web app sends no credentials today, so requiring a token needs a way to get it into the browser, and a small client change.
- **The token.** The server generates a random token on first start. It stores it in the data directory, readable only by the user (0600).
- **Bootstrap.**
  - At startup, the server prints a launch URL that carries the token in its fragment: `http://127.0.0.1:8787/#token=…`. A fragment never reaches server logs or `Referer` headers. The server can also open that URL itself.
  - The web app reads the fragment and removes it from the address bar.
  - It exchanges the token once, at `POST /session`, for a session cookie marked `HttpOnly` and `SameSite=Strict`.
- **Requests.** Every API request carries the cookie, including event streams and exports, which all go through `fetch` with `credentials: "include"`. Clients that aren't browsers, such as `curl`, send `Authorization: Bearer <token>` instead.
- **Exempt from the token, but still Host-checked:**
  - CORS preflights, which never carry credentials;
  - the built web app's static files, which hold no secrets;
  - `POST /session`, which checks the token itself.
- **Development.** Vite serves the web app on port 5173 and the API runs on 8787. Both are `localhost` and therefore the same site, so the `SameSite=Strict` cookie is sent. CORS allows credentials only for the exact origins in `CONCLAVE_WEB_ORIGIN`.
- **Client changes:**
  - `credentials: "include"` on its `fetch` calls;
  - reading the launch URL's fragment;
  - a screen that asks the user to open the launch URL when there's no session.
- **What it protects against.**
  - **Other local users:** they can read neither the token file nor the launch URL.
  - **Websites:** they can't make the browser send a `SameSite=Strict` cookie, can't read cross-origin responses, and can't get past the Host allowlist by DNS rebinding.
  - **Not covered:** processes running as the same user can read the token, just as they can already read `state.json`.
- Rust itself adds less than it sounds, because JavaScript is memory-safe too.

**Speed.** Rust handles each event in microseconds and uses tens of MB less memory than Node, but users won't notice either. The visible gains:
- Cache provider status and model lists, and refresh them in the background instead of starting CLIs on every page load. These don't authorize a model call, so caching them doesn't weaken the subscription guarantee (§5).
- The library-wide improvements in the [runtime proposal §8][runtime-speed].

**Switching over.**
- During the port, the Rust server runs alongside the TypeScript server on another port.
- It becomes the default once three things hold:
  - it passes the whole recorded contract, plus tests for the new security behavior, including the token handoff when the server serves the web app and in the Vite development setup;
  - it serves all four providers;
  - it loads real data, both from `~/.conclave` and from a directory set with `CONCLAVE_DATA_DIR`.
- The TypeScript server stays available for one release as a fallback, and is then removed.

## 5. Provider behavior

**Sign-in checks and the subscription-only guarantee.**
- **Where a check is needed.**
  - For Claude and Codex, the guarantee needs a check before every model call, because either CLI may be signed in with an API-key, Console, or cloud account. The library classifies the sign-in, and Conclave refuses anything but a subscription.
  - For Gemini and Grok, the launch itself enforces it. API-key variables are never passed, and Grok also runs with `GROK_DISABLE_API_KEY_AUTH`.
- **The check never runs alongside a model call.** It finishes before the provider process starts.
- **Caching the check is a Conclave setting, off by default.**
  - When on, a successful check is reused for a short set time, and any authentication or provider failure invalidates it immediately.
  - The setting's description states the tradeoff: within that time, a CLI that has switched to API-key or Console sign-in goes unnoticed, and a call could be billed.
- **If the check turns out to dominate latency,** look for evidence the CLI reports before any model request, provider by provider, rather than starting billable work early.

**Every Conclave turn is `Ephemeral`.** This is the library's session policy, so nothing a provider saves outlives the call. Claude runs with `--no-session-persistence`, and the other providers' files are removed after each turn.

**Fixes to shared behavior go to the library.**
- A problem in one of the four shared adapters is fixed in the library, and both Conclave and Pervue pick up the fix by bumping their pin.
- Conclave never patches shared adapter behavior locally. That would let the two apps drift apart again.

**Parity checks.** Beyond the HTTP contract, each provider must match Conclave's current behavior, except where noted.
- **Gemini:**
  - listing `gemini-` models from `agy models`, with Conclave still mapping its legacy aliases (`auto`, `pro`, `flash`, `flash-lite`);
  - refusing Antigravity's direct Gemini API-key mode;
  - the tool-free agent and the `init` checks;
  - usage from the final `result`;
  - the absolute turn limit;
  - cancellation;
  - the same failures in the run inspector.

  It also brings three changes in behavior:
  - transcripts are deleted after each call;
  - the agent definition sets `hooks: []`;
  - a turn fails when Antigravity reports a step type it doesn't document.
- **Grok:**
  - the model choices Conclave offers today;
  - OAuth-only sign-in;
  - no tools;
  - the absolute turn limit;
  - cancellation;
  - the same failures in the run inspector.

  It also changes behavior: answers arrive a message at a time.
- **Claude:**
  - refusing sign-ins that aren't subscriptions;
  - the `sonnet`, `opus`, and `haiku` aliases;
  - usage events;
  - no tools;
  - no session persistence;
  - the system prompt;
  - the absolute turn limit;
  - cancellation;
  - the same failures in the run inspector.
- **Codex:** the same list as Claude. It also changes behavior:
  - answers arrive a message at a time;
  - models come from the list kept by hand;
  - the usage panel shows as unavailable.

## 6. Plan

These steps make up Stage 3 of the [runtime plan][runtime-stages]. Steps 1, 2, and 4 don't need the library, so they can run while the library's Stages 1 and 2 are in progress. Steps 3 and 5 wait for its Stage 2.

1. **Record the HTTP contract** (§3).
2. **Port storage and the HTTP API** against the contract, using the mock provider:
   - generate the web app's types;
   - add the token and its handoff (including the web app's small client change), and the Host allowlist, with their own tests;
   - keep the 1 MiB body limit, and every configuration variable, as §4 describes.
3. **First milestone: one slice end to end,** for example the Panel mode with Gemini through the library.
4. **Port the rest of the orchestrator** together with its tests.
5. **Connect all four providers** through the library.
6. **Switch over** (§4).

**Afterwards:** speed work, measured with real CLIs ([runtime proposal §8][runtime-speed]).

## 7. Fallback

If the port stalls, the library's service API can be wrapped in a sidecar executable that speaks JSON-RPC over stdio. The Node server then replaces its adapters one at a time behind a flag, such as `CONCLAVE_RUNTIME_PROVIDERS=google`. The library itself doesn't change.

## 8. Risks

- **The TypeScript server's security gaps stay open until the switch-over.** That was a deliberate decision. Until then:
  - Keep the default bind to `127.0.0.1`.
  - Don't set `CONCLAVE_HOST` to a reachable interface, or put the server behind a tunnel.
  - A DNS-rebinding attack needs a malicious site to be open in a browser while Conclave is running. Browsers that block requests from public sites to private networks reduce this risk, but don't remove it.
- **The port stalls or drifts.** The recorded contract, running both servers side by side, and the TypeScript fallback limit the damage. The sidecar (§7) remains available.
- **Stored data compatibility.** Existing files must load unchanged. Test with real data before switching.
- **Feature work during the port.** Either freeze Conclave's features, or port in parallel and re-sync (§9).
- **Contributors need Rust** for everyday server work. The web app stays TypeScript.
- **Less isolation in-process.** The library's supervisor contains panics, but an abort, such as running out of memory, takes the server down. Conclave's existing recovery then marks unfinished runs `interrupted` at startup.
- **Slower-looking answers for OpenAI and Grok,** because they arrive a message at a time.
- **Stricter provider behavior.**
  - The environment allowlist may drop a variable someone relies on. Conclave can extend it through its startup configuration, never from per-call input.
  - Private workspaces mean project `CLAUDE.md` files no longer apply.
  - The stricter Gemini and Grok checks can fail turns that pass today when a CLI release changes its output.

## 9. Open decisions

1. Should Rust become the source of truth for the web app's types (recommended)?
2. Freeze Conclave's features during the port, or port in parallel and re-sync?
3. Caching the sign-in check: keep it off by default (recommended), and what time limit when it's on?
4. Where does the OpenAI model list that's kept by hand live, and who updates it when OpenAI's models change?
5. Does Conclave accept the library's stricter defaults, the environment allowlist and private workspaces, as they are?
6. Should the session cookie expire, and how is the per-install token rotated?

[runtime-proposal]: https://github.com/davletovb/pervue/blob/claude/eloquent-franklin-8qo1f1/docs/architecture/provider-runtime-extraction-proposal.md
[runtime-stages]: https://github.com/davletovb/pervue/blob/claude/eloquent-franklin-8qo1f1/docs/architecture/provider-runtime-extraction-proposal.md#7-stages
[runtime-speed]: https://github.com/davletovb/pervue/blob/claude/eloquent-franklin-8qo1f1/docs/architecture/provider-runtime-extraction-proposal.md#8-speed-and-cold-start
[runtime-conclave]: https://github.com/davletovb/pervue/blob/claude/eloquent-franklin-8qo1f1/docs/architecture/provider-runtime-extraction-proposal.md#conclave
[c-index]: https://github.com/davletovb/conclave/blob/1379a37ccb13d484247122ee215257e642b166fc/apps/server/src/index.ts
[c-claude-auth]: https://github.com/davletovb/conclave/blob/1379a37ccb13d484247122ee215257e642b166fc/apps/server/src/providers/anthropic-claude.ts#L235
