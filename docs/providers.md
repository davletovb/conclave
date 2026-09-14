# Provider runtimes

Conclave uses local, subscription-backed provider runtimes behind a shared adapter interface. The browser never authenticates directly with model providers and never talks to their runtimes itself; the local Conclave server owns provider discovery, generation, streaming, cancellation, and authentication checks.

The current provider set is:

| Provider | Runtime | Accepted account path |
| --- | --- | --- |
| OpenAI | Codex `app-server` | ChatGPT sign-in |
| Anthropic | Claude Code | `claude.ai` account sign-in |
| xAI | Grok Build ACP | cached Grok/X OAuth |
| Google Gemini | Antigravity CLI (`agy`) | cached Google-account sign-in |

If a runtime is missing or not authenticated, Conclave keeps a mock model available so the rest of the application and orchestration UI remain usable.

## Design principle: subscription first

Conclave intentionally prefers supported subscription-backed local runtimes rather than direct model API billing.

That boundary is enforced per provider:

- OpenAI API-key Codex sessions are not accepted as the ChatGPT subscription path.
- Claude Console/API-key and cloud-provider authentication are not accepted as the Claude subscription path.
- xAI API-key and custom-endpoint environment routes are removed before Grok ACP is launched.
- Google direct Gemini/API/Vertex credential routes are removed before Antigravity is launched.

This is not a claim that subscription plans provide identical entitlements or telemetry. Each provider exposes different account limits, model catalogs, usage information, and CLI behavior.

## OpenAI / ChatGPT

Conclave expects the official Codex CLI on the same machine.

Authenticate interactively:

```bash
codex
```

Choose **Sign in with ChatGPT** and complete the browser flow. Restart `pnpm dev` after authentication.

The OpenAI adapter talks to Codex through `codex app-server`. If Codex is authenticated with an API key rather than the ChatGPT account path, Conclave leaves the subscription-backed OpenAI provider disconnected by design.

### Cancellation

An active Codex call is interrupted through Codex's `turn/interrupt` mechanism rather than merely disconnecting the browser client.

### Usage visibility

When Codex exposes `account/rateLimits/read`, Conclave can show structured ChatGPT subscription-window usage. This is provider-reported data; Conclave does not synthesize equivalent estimates for providers that do not expose comparable structured limits.

## Anthropic / Claude

Conclave expects the official Claude Code CLI.

Check installation:

```bash
claude --version
```

Authenticate through the normal Claude account flow:

```bash
claude auth login
claude auth status
```

Use the standard **claude.ai** subscription login. Do not use `claude auth login --console` for the Conclave subscription path, because that selects Console/API usage billing.

Restart `pnpm dev` after authentication.

The Claude adapter checks `claude auth status` before model listing or generation and accepts the first-party `claude.ai` authentication path. API/platform credential environment variables are removed from Claude child processes, which are run in non-persistent print mode without Conclave granting tool execution.

Conclave currently exposes Claude Code's stable aliases:

- `sonnet`
- `opus`
- `haiku`

Claude Code resolves those aliases to the concrete models available to the signed-in account.

### Usage credits

Claude paid plans can separately enable Anthropic **usage credits**. If that account-level feature is enabled, Anthropic may use credits after included subscription limits are exhausted. Conclave cannot override that provider-side account setting.

### Cancellation

An active Claude call is stopped by terminating that call's non-interactive Claude child process.

## xAI / Grok

Install the official Grok Build CLI using xAI's supported installation path, then verify and authenticate:

```bash
grok version
grok login
```

Complete the browser OAuth flow with the Grok/X account associated with the subscription. On a headless or remote machine, Grok Build also supports device-code authentication through its CLI.

Restart `pnpm dev` after sign-in.

Conclave talks to Grok through the official Agent Client Protocol transport using `grok agent stdio`.

The adapter accepts the ACP cached-token authentication path and deliberately does not use `xai.api_key`. Before launching Grok ACP, Conclave removes xAI API-key, legacy API-key, and custom model-endpoint environment routes from the child process.

The built-in Grok catalog currently exposed by the adapter mirrors the subscription-backed choices supported by the installed Grok Build runtime.

### Cancellation

Each active Grok call gets a dedicated ACP process. Cancellation closes that process rather than only ending the HTTP/browser connection to Conclave.

## Google / Gemini

Conclave uses Google's Antigravity CLI rather than calling Gemini APIs directly.

After installing Antigravity, verify the CLI and run one interactive session:

```bash
agy --version
agy
```

Complete **Sign in with Google** using the Google account associated with the desired Gemini access/subscription. Antigravity stores that authentication through its supported local credential mechanism; Conclave reuses the cached account login and does not initiate OAuth itself.

Restart `pnpm dev` after sign-in.

### Model discovery

Conclave discovers the signed-in account's current Gemini catalog using:

```bash
agy models
```

Only model IDs beginning with `gemini-` are exposed as live Gemini models. Conclave does not hard-code current preview model names, so the visible model list follows Antigravity's live catalog.

Persisted runs created during the earlier Gemini CLI adapter can still contain the short-lived aliases `auto`, `pro`, `flash`, and `flash-lite`; those are accepted for resume compatibility and mapped to the closest live Antigravity model.

### Execution boundary

For generation, Conclave runs Antigravity headlessly with stream JSON input/output, sandboxing, and a Conclave-owned primary agent.

The generated primary agent is intentionally configured as a text-only boundary: no inherited MCP configuration, no inherited plugins/skills/rules/agents, no command execution, no subagent role, and no Conclave-granted execution tools.

Prompts are sent over stdin rather than placed on the process command line.

Before launching `agy`, Conclave removes direct Gemini/API/Vertex credentials, custom Gemini endpoints, and inherited Antigravity conversation/browser/sidecar state while preserving the normal user home directory so Antigravity can access the supported OS-keyring Google login.

The adapter verifies the Antigravity initialization event and rejects unsafe or unexpected execution states. Actual tool activity or subagent activity during a Conclave generation fails the call closed.

Antigravity may report a process-wide tool registry in initialization metadata even when the selected Conclave agent itself is configured with no tools; Conclave therefore distinguishes that global registry from actual tool/subagent activity by the selected agent.

### Cancellation and cleanup

Every generation runs in its own temporary workspace. Cancellation and timeout terminate the dedicated `agy` process group, using graceful termination first and a forced kill fallback when required. Temporary state is removed after the child process has actually closed.

## Inspect provider status

With the local server running:

```bash
curl http://localhost:8787/providers
```

Model discovery is available through:

```bash
curl http://localhost:8787/models
```

## Provider telemetry differences

The normalized Conclave event protocol can carry text, usage, citation/tool metadata, progress, completion, and errors, but not every local runtime exposes the same level of detail.

In particular:

- token counts are best-effort;
- interrupted calls may not produce final usage totals;
- only provider-reported structured subscription limits are shown;
- a missing structured quota API is displayed as unavailable rather than replaced by an estimate.

These differences are expected and remain isolated behind the provider adapter layer.
