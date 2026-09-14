# Conclave

**Bring the models to the same table.**

Conclave is a local-first multi-model reasoning environment where GPT, Claude, Grok, Gemini, and future providers can answer independently or work together through explicit orchestration workflows.

It is not primarily a model switcher. The point is to make **comparison, disagreement, critique, synthesis, delegation, and verification** first-class parts of the reasoning process while keeping the underlying model work visible.

Conclave runs locally and is designed around subscription-backed provider runtimes rather than direct model API-key integrations. Optional shared web search can give every participating model the same retrieved evidence before a run starts.

> **Status:** actively developed personal project. The web app, persistent run system, four provider adapters, orchestration modes, custom workflows, and shared web search are implemented.

## Why Conclave

Asking several models the same question is useful, but simply putting four chat windows beside each other leaves the hard part to the user: deciding what matters, where they disagree, and how to turn several answers into one better result.

Conclave makes that process explicit.

- **Independent first passes** preserve different model perspectives before synthesis.
- **Structured orchestration** defines who answers, critiques, judges, revises, routes, or synthesizes.
- **Visible council work** keeps intermediate reasoning products inspectable instead of hiding them behind one final answer.
- **Shared evidence** can ground every model in the same web-search results.
- **Local persistence** keeps conversations, run history, partial output, and inspection data on the machine running Conclave.
- **Subscription-first adapters** reuse supported local provider runtimes and their existing account sign-ins.

## What Conclave can do

| Capability | What it means |
| --- | --- |
| Multi-model runs | Use OpenAI, Anthropic, xAI, and Google models in one conversation |
| 12 orchestration modes | Compare, debate, synthesize, critique, judge, route, red-team, plan, and build custom workflows |
| Shared web evidence | Search once through SearXNG and give every selected model the same evidence packet |
| Persistent runs | Refresh or close the browser without cancelling work already owned by the local server |
| Streaming | See model output and final answers arrive incrementally |
| Partial-failure recovery | Preserve useful sibling results when one provider fails, with bounded retry for transient failures |
| Run controls | Set call budgets, stop active work, resume interrupted/cancelled attempts, and inspect execution |
| Custom workflow graphs | Build validated dependency graphs with parallel branches and explicit output nodes |
| Conversation tools | Search, rename, delete, and export conversations as Markdown or JSON |
| Local-first interface | Light/dark themes, keyboard controls, accessibility support, and responsive layout |

## Providers

Conclave currently supports four subscription-backed local adapters:

| Provider | Local runtime | Authentication |
| --- | --- | --- |
| OpenAI | Codex `app-server` | Sign in with ChatGPT |
| Anthropic | Claude Code | `claude.ai` account sign-in |
| xAI | Grok Build ACP | Grok/X OAuth sign-in |
| Google Gemini | Antigravity CLI | Google account sign-in |

If a provider runtime is missing or not authenticated, Conclave keeps a mock model available so the rest of the application remains usable.

Provider-specific authentication rules, model discovery, process isolation, cancellation behavior, and setup instructions live in **[Provider runtimes](docs/providers.md)**.

## Orchestration modes

Conclave ships with twelve built-in ways to organize model work:

| Mode | Flow |
| --- | --- |
| **Single** | One model → answer |
| **Compare** | Independent answers shown side by side |
| **Panel** | Independent answers → synthesis |
| **Debate** | Independent positions → bounded critique rounds → judgment |
| **Critic → Revise** | Draft → critique → author revision |
| **Consensus** | Independent answers → proposed consensus → separate consensus audit |
| **Judge** | Candidate answers → adjudication |
| **Red Team** | Draft → attacks from other models → hardened revision |
| **Router** | Router chooses one selected specialist → specialist answers |
| **Research Council** | Evidence, alternatives, implementation risks, and skepticism → synthesis |
| **Planner → Executors** | Planner → parallel executors → reviewer |
| **Custom Workflow** | Validated dependency graph with user-defined roles and prompts |

Multi-stage modes are bounded before execution. Debate, for example, allows 1–3 critique rounds, and every run is checked against its call budget before provider work begins.

## Shared web evidence

Conclave can perform one provider-independent web search before a persistent run. The retrieved results are normalized into a single evidence packet and injected into every selected model as system context.

That matters for multi-model work: Compare, Debate, Judge, Consensus, Research Council, and custom workflows can reason over the **same retrieved material** instead of each provider seeing a different browsing environment—or none at all.

Search currently uses SearXNG and is deliberately separate from provider-native browsing tools.

See **[Shared web search](docs/web-search.md)** for setup and behavior.

## How it works

```text
                         optional
                      ┌───────────┐
                      │  SearXNG  │
                      └─────┬─────┘
                            │ shared evidence
                            ▼
┌──────────────┐      ┌───────────────┐      ┌─────────────────────┐
│ React + Vite │ ───► │ Fastify server│ ───► │ Orchestration engine │
│     web UI   │      │  + run store  │      └──────────┬──────────┘
└──────────────┘      └───────────────┘                 │
                                                        │
                    ┌───────────────────────────────────┼───────────────┐
                    ▼                                   ▼               ▼
              Codex runtime                       Claude Code       Grok / Gemini
```

The browser never talks directly to provider runtimes. The local server owns provider processes, orchestration, persistence, cancellation, retries, search evidence, and the normalized event stream consumed by the UI.

Conversations and runs are persisted locally. A run belongs to the server rather than to one browser request, so reconnecting clients can replay events they missed.

For the execution model, persistence format, budgets, retries, API surface, and environment variables, see **[Runtime and architecture](docs/runtime.md)**.

## Quick start

### Requirements

- Node.js 22+
- pnpm 10+

### Install and run

```bash
git clone https://github.com/davletovb/conclave.git
cd conclave
pnpm install
pnpm dev
```

Then open:

- Web UI: `http://localhost:5173`
- Local server: `http://localhost:8787`

Conclave can run with mock providers immediately. Connect any real provider runtime you want to use.

### Connect provider subscriptions

**OpenAI / ChatGPT**

```bash
codex
```

Sign in with ChatGPT, then restart `pnpm dev`.

**Anthropic / Claude**

```bash
claude auth login
claude auth status
```

Use the normal `claude.ai` account flow, then restart Conclave.

**xAI / Grok**

```bash
grok login
```

Complete the Grok/X OAuth flow, then restart Conclave.

**Google / Gemini**

```bash
agy
```

Complete Google sign-in in Antigravity, then restart Conclave.

For installation details and the exact authentication boundary used by each adapter, see **[Provider runtimes](docs/providers.md)**.

### Optional: enable shared web search

Run a SearXNG instance with JSON search enabled, then:

```bash
export CONCLAVE_SEARXNG_URL=http://127.0.0.1:8080
pnpm dev
```

Enable **Shared web search** in Run configuration → Web evidence.

## The interface

Conclave separates the **answer you read** from the **machinery that produced it**.

The final answer uses a reading-focused surface, while model steps, provider identity, budgets, timing, token telemetry, and run controls stay visually distinct. Council work is collapsible, long outputs are bounded until expanded, and active runs expose their current progress without forcing the transcript to stay pinned when you scroll away.

Other interface features include:

- conversation search across titles and message bodies;
- Markdown and JSON export;
- command palette (`Ctrl`/`Cmd` + `K`);
- keyboard-first run, navigation, expand/collapse, theme, and stop controls;
- structured custom-workflow editing with cycle prevention;
- run inspection with step status, timing, usage, errors, retries, and dependency lineage;
- light and dark themes;
- focus management, live-region announcements, visible focus states, reduced-motion support, and responsive layouts down to mobile widths.

## Custom workflows

Custom Workflow mode turns orchestration into a validated graph instead of a fixed frontend recipe.

A workflow can define:

- stable node IDs;
- step kind;
- participant or synthesizer assignment;
- dependencies;
- prompt templates;
- one explicit output node.

Nodes start as soon as their own prerequisites are satisfied, so independent branches can run in parallel.

Prompt templates support:

```text
{{prompt}}            original user request
{{dependencies}}      all declared upstream outputs
{{dep.<nodeId>}}      one declared upstream output
```

Conclave ships with initial presets including **Triangulate**, **Challenge → Revise**, and **Decision Board**, all of which can be edited in the structured workflow editor or as raw JSON.

## Reliability and run controls

Multi-model orchestration becomes expensive and frustrating if one slow or broken provider can wedge the whole run. Conclave therefore treats run lifecycle as a first-class system concern.

Current behavior includes:

- server-enforced model-call budgets;
- preflight call-count validation;
- provider cancellation that reaches the active local runtime process;
- durable partial output;
- resume as a new attempt after cancellation, interruption, or failure;
- one bounded retry for transient/stalled provider steps when budget remains;
- preservation of successful sibling outputs in supported parallel modes;
- provider rate-limit/quota errors recorded with the run;
- inactivity watchdogs for calls that stop producing progress events;
- deterministic event replay after reconnect.

See **[Runtime and architecture](docs/runtime.md)** for the details.

## Repository structure

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

The architecture is deliberately provider-agnostic: provider adapters sit behind shared contracts so the orchestration engine and UI do not need provider-specific logic for every workflow.

## Local data and network boundary

By default the server binds to `127.0.0.1`, and the browser origin allowlist is limited to the local development UI.

Persistent state is stored under:

```text
~/.conclave/
  state.json
  runs/<run-id>.ndjson
```

On macOS/Linux, Conclave tightens its data directories and persisted state/event files to owner-only permissions.

Exposing the server beyond the local machine should be treated as an explicit deployment and security decision rather than the default mode of operation.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
```

GitHub Actions runs the same verification gates on pull requests.

## Documentation

- **[Provider runtimes](docs/providers.md)** — provider installation, subscription authentication, runtime boundaries, models, cancellation, and quota visibility
- **[Runtime and architecture](docs/runtime.md)** — persistence, streaming events, budgets, retries, API endpoints, environment configuration, and run lifecycle
- **[Shared web search](docs/web-search.md)** — SearXNG configuration, shared evidence behavior, and current search scope

## Project direction

Conclave is currently web-first and local-first. Desktop/native packaging is intentionally deferred so the provider and orchestration core can remain transport-independent.

The broader direction is to make multi-model work more useful than simply asking several models the same question: clearer division of roles, better evidence handling, stronger inspection, and workflows where disagreement is preserved long enough to be useful.
