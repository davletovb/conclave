# Shared web search

Conclave can perform one provider-independent web search before a persistent run and give every selected model the same evidence packet. This keeps Compare, Panel, Debate, Judge, Consensus, Research Council, and custom workflows grounded in the same retrieved material instead of relying on provider-specific browsing behavior.

## Configure SearXNG

Run or use a SearXNG instance whose `/search` endpoint allows JSON output, then start Conclave with:

```bash
export CONCLAVE_SEARXNG_URL=http://127.0.0.1:8080
pnpm dev
```

Optional search timeout, in milliseconds:

```bash
export CONCLAVE_SEARCH_TIMEOUT_MS=12000
```

In **Run configuration → Web evidence**, turn on **Shared web search**. New runs then request up to six normalized results by default.

## Behavior

- Search happens on the Conclave server before any model call is started.
- If search is unavailable, times out, or returns no usable results, the run is rejected before subscription-backed model calls are consumed.
- The resolved evidence is stored inside the persistent run request. Resuming a failed/interrupted/cancelled run therefore reuses the original evidence rather than searching a newer web.
- The visible user message remains the original prompt; search snippets are injected only as a system-context evidence packet at execution time.
- All selected models receive the same packet.
- Retrieved snippets are explicitly marked as **untrusted external content**. Models are instructed to ignore instructions contained inside snippets/pages and treat the material only as evidence.
- Result URLs are limited to HTTP(S), fragments are removed, duplicate URLs are collapsed, and snippets/titles are length-bounded before entering model context.

## Current scope

The first implementation intentionally supports only **shared search**. It does not enable each provider runtime's native browsing tools. A future independent-research mode can add agent-directed follow-up searches without changing the model-provider abstraction.
