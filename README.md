# Conclave

Conclave is a personal multi-model reasoning environment: one interface where GPT, Claude, Grok, and future providers can answer independently or work together through explicit orchestration workflows.

## Initial modes

- **Single** — one model, one answer
- **Compare** — independent answers side by side
- **Panel** — independent answers, then synthesis
- **Debate** — independent positions, bounded critique rounds, then judgment
- **Critic → Revise** — one model drafts, another critiques, the author revises

The architecture is deliberately provider-agnostic so subscription-backed runtimes can be added behind adapters without changing the UI or orchestration engine.

## Repository structure

```text
apps/
  web/       React + Vite interface
  server/    Fastify orchestration/runtime service
packages/
  core/      shared provider + orchestration contracts
```

The browser never talks directly to provider runtimes. The server owns provider authentication and local processes such as Codex app-server, Claude Agent SDK/CLI, and Grok ACP.

## Current status

The first vertical slice runs against mock GPT/Claude/Grok personalities. This lets orchestration semantics and UX be tested before real provider authentication is added.

## Run locally

Requirements: Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

- Web: `http://localhost:5173`
- Server: `http://localhost:8787`

Override the server URL with `VITE_CONCLAVE_API` when needed.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

GitHub Actions runs the same checks on pull requests.

## Near-term roadmap

1. OpenAI adapter via subscription-authenticated Codex runtime
2. Anthropic adapter via Claude Agent SDK/runtime
3. xAI adapter via Grok ACP/headless runtime
4. Streaming event protocol for partial output and tool calls
5. Persistent conversations and resumable orchestration runs
6. Consensus, Judge, Red Team, Router, Research Council, and Planner/Executor modes
7. Per-run budgets, round limits, cancellation, and usage/rate-limit visibility
