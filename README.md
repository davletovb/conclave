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

OpenAI is now connected through the official local `codex app-server` runtime. If Codex is signed in with a ChatGPT account, Conclave discovers the models available to that account and sends OpenAI turns through the ChatGPT subscription allowance. Claude and Grok remain mocks until their adapters land.

Conclave intentionally refuses Codex sessions authenticated with an OpenAI API key so it cannot silently switch from subscription usage to metered API billing.

## Run locally

Requirements: Node.js 22+ and pnpm 10+.

```bash
pnpm install
pnpm dev
```

- Web: `http://localhost:5173`
- Server: `http://localhost:8787`

Override the server URL with `VITE_CONCLAVE_API` when needed.

## Connect your ChatGPT subscription

Conclave expects the official Codex CLI on the same machine. On macOS you can install it with one of the official options:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
# or
npm install -g @openai/codex
# or
brew install --cask codex
```

Then run:

```bash
codex
```

Choose **Sign in with ChatGPT** and complete the browser login. Restart `pnpm dev` afterward. The Conclave sidebar should change from `OpenAI not connected · mocks active` to your ChatGPT plan, and `/models` will expose the models Codex reports for that account.

If Codex is authenticated with an API key, Conclave will leave OpenAI disconnected by design. Sign out of that Codex session and sign back in with ChatGPT if you want subscription-backed usage.

You can inspect the local provider state at:

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
2. Anthropic adapter via Claude Agent SDK/runtime
3. xAI adapter via Grok ACP/headless runtime
4. Streaming event protocol for partial output and tool calls
5. Persistent conversations and resumable orchestration runs
6. Consensus, Judge, Red Team, Router, Research Council, and Planner/Executor modes
7. Per-run budgets, round limits, cancellation, and usage/rate-limit visibility
