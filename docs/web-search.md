# Native web search through Seatline

Conclave no longer uses a separate SearXNG instance. Web search is optional and is executed using each selected model provider's native search tools through Seatline, as in TabBeam.

## Setup

Connect the hosted Conclave web app to Seatline, using the shared companion setup. In **Run configuration → Web evidence**, enable **Native web search**. The selection is stored in local browser settings for subsequent runs.

No search-engine API key, separate search server, or `CONCLAVE_SEARXNG_URL` is needed. Search is currently supported by Seatline adapters for Codex, Claude, and Gemini when their runtime advertises `web_search: true`; the current Grok runtime reports it unsupported. The standalone Fastify provider adapters do not use Seatline's search policy, so search is unavailable with those adapters.

## Execution

- Each model step gets `native_web_search` as its Seatline tool policy instead of `none`. The companion enforces sign-in policy as before.
- Search runs via the model provider, so sources and research paths **can differ between models**. This intentionally replaces the previous identical shared-evidence packet. If identical input sources are required for an experiment, a separate future evidence-collection phase would be needed.
- Seatline emits normalized source events. Conclave accepts HTTP(S) URLs, deduplicates them per step, and surfaces them as citation events in the persisted run stream.
- The provider must advertise native web-search capability, and a search turn without usable sources fails explicitly instead of being represented as a grounded answer.
- Search may increase latency and provider usage; no external search engine is billed by Conclave.
- Search result text is untrusted external content. Seatline's native search policy isolates non-search tools, but answers and citations still require scrutiny; cited URLs are not automatically independently verified.

## Compatibility

Older saved SearXNG evidence packets remain readable and are still injected as historical evidence when resuming a run that already stored one; no SearXNG requests can be made. New requests selecting legacy `shared` mode are rejected with a migration message. The old search provider implementation, test suite, and environment variable are removed.
