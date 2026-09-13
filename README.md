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

The browser never talks directly to provider runtimes. The server owns provider authentication and local processes such as Codex app-server, Claude Code, and Grok Build ACP.

## Current status

All three initial providers now have subscription-backed local adapters:

- OpenAI through `codex app-server` and ChatGPT sign-in
- Anthropic through Claude Code and `claude.ai` sign-in
- xAI through Grok Build ACP and cached Grok/X OAuth sign-in

If a runtime is missing or not authenticated, Conclave keeps that provider's mock model available so the rest of the app remains usable.

The adapters are intentionally subscription-first. Conclave refuses OpenAI API-key Codex sessions, refuses Claude Console/API-key or cloud-provider authentication, and removes xAI API-key/custom-endpoint environment routes before launching Grok ACP.

Claude paid plans can separately enable Anthropic **usage credits**. If usage credits are enabled on the Claude account, Anthropic may use them after included subscription limits are exhausted. That is an account-level Claude setting; Conclave cannot override it.

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
4. Streaming event protocol for partial output and tool calls
5. Persistent conversations and resumable orchestration runs
6. Consensus, Judge, Red Team, Router, Research Council, and Planner/Executor modes
7. Per-run budgets, round limits, cancellation, and usage/rate-limit visibility
