import type { ModelRef, ProviderAdapter, ProviderEventSink, ProviderId, ProviderLimitSnapshot, ProviderRequest, ProviderResponse, ProviderStatus } from "@conclave/core";
import { SeatlineClient, failureReason, type SeatlineEvent, type SeatlineLink } from "./companion";

const DEFAULT_MODEL = "seatline:default";
// The UI asks for status often and in bursts; a run checks the provider once per step. Both reuse a recent answer here instead of
// asking the companion each time, and the companion reuses a verified check instead of starting a provider process each time.
const STATE_REUSE_MS = 2_000;
const PREFLIGHT_REUSE_MS = 30_000;
/** An age no answer can satisfy: always ask the companion. */
const FRESH = -1;
/**
 * Seatline's readiness API reuses a verified sign-in/availability result for at most this long (its own ceiling). It still drops the
 * result when the account or its configuration files change or a turn fails to authenticate; the window bounds what it cannot see
 * (a keyring change, a revocation on the server). Evidence that old is never reused here either, however recently it was fetched.
 */
const READINESS_MAX_AGE_MS = 30_000;
/** Preparing a provider is best effort and happens at most this often for each. */
const PREPARE_INTERVAL_MS = 10_000;

const CACHED = { mode: "cached", max_age_ms: READINESS_MAX_AGE_MS } as const;
const NEW_CHECK = { mode: "fresh" } as const;
type Freshness = typeof CACHED | typeof NEW_CHECK;
/** Seatline refused before it started a turn, because the evidence a send named had changed or lapsed. Nothing ran. */
const REFUSED_BEFORE_START = new Set(["READINESS_CHANGED", "READINESS_EXPIRED", "READINESS_UNVERIFIED"]);

type Status = NonNullable<SeatlineEvent["status"]>;

/** How to sign each provider's CLI in, for the message that asks the user to. */
const SIGN_IN: Record<string, string> = { codex: "codex login", claude: "claude auth login", gemini: "agy", grok: "grok login" };

/**
 * Why a provider cannot be used, in words the user can act on, or nothing when it can. Seatline reports whether the CLI is there,
 * whether it is signed in and what kind of sign-in it is; Conclave accepts subscription sign-ins (and Google's cloud account).
 */
export function unusableReason(provider: string, label: string, state: Status, accepted: (mode?: string) => boolean): string | undefined {
  const signIn = SIGN_IN[provider] ? `\`${SIGN_IN[provider]}\`` : "the provider's CLI";
  if (state.availability === "not_found") return `${label} is not installed on this computer, or Seatline cannot find it.`;
  if (state.authentication === "unauthenticated") return `Signed out. Sign in with ${signIn} on this computer, then retry.`;
  if (state.authentication !== "authenticated") {
    return state.availability === "available"
      ? "Seatline could not confirm the sign-in: the check did not finish. Retry; if it keeps happening, update Seatline."
      : `Seatline could not run ${label} to check it. Make sure it starts from a terminal, then retry.`;
  }
  if (accepted(state.sign_in)) return undefined;
  if (state.sign_in === "api_key") return `Signed in with an API key. Conclave uses subscription sign-ins: sign in with ${signIn}.`;
  if (state.sign_in === "cloud") return `Signed in through a cloud provider. Conclave uses subscription sign-ins: sign in with ${signIn}.`;
  return `Signed in, but Seatline cannot tell whether it is a subscription. Update Seatline, or sign in again with ${signIn}.`;
}
/** A provider's status and when the evidence behind it was observed: now, minus the age Seatline reports. */
type Reading = { status: Status; observedAt: number };

/**
 * What the companion behind a client has shown, shared by every provider that uses it: Seatline's readiness API (true), a companion
 * that predates it (false), or not yet known. It is forgotten when the companion reconnects, so an updated companion is noticed.
 */
const capabilities = new WeakMap<object, { readiness: boolean | undefined; generation: number | undefined }>();
function capability(client: object, link?: SeatlineLink) {
  const generation = link?.generation();
  let known = capabilities.get(client);
  if (!known || known.generation !== generation) { known = { readiness: undefined, generation }; capabilities.set(client, known); }
  return known;
}

export class SeatlineProvider implements ProviderAdapter {
  constructor(readonly id: Exclude<ProviderId, "mock">, readonly label: string,
    private readonly provider: string, private readonly client: SeatlineClient, private readonly link?: SeatlineLink) {}

  private usable(state: Status) { return state.authentication === "authenticated" && this.acceptedSignIn(state.sign_in); }

  private acceptedSignIn(mode?: string) { return mode === "subscription" || (this.id === "google" && mode === "cloud"); }

  private get companion() { return capability(this.client, this.link); }

  /**
   * The provider's readiness: from Seatline's cache when `freshness` allows, or, for a companion without the readiness API, a status
   * request (which is always a new check). Seatline never caches a signed-out, missing or failed result, so asking again after the
   * user signs in needs no special handling there.
   */
  private async fetchState(freshness: Freshness): Promise<Reading> {
    let status: Status | undefined;
    let answered: ReturnType<typeof capability> | undefined;
    const take = (event: SeatlineEvent) => { if (event.type === "status") { status = event.status; answered = this.companion; } };
    let known = this.companion;
    for (let attempt = 0; known.readiness !== false; attempt++) {
      try {
        status = undefined; answered = undefined;
        await this.client.request(this.provider, "readiness", attempt === 0 ? freshness : NEW_CHECK, take);
        // The first request may complete the 0 -> 1 handshake. Remember the
        // capability on the connection that answered, including reconnects.
        known = answered ?? this.companion;
        known.readiness = true;
        break;
      }
      catch (error) {
        // The evidence changed while it was being checked: a CLI that writes its own account file while it is checked (Claude, the
        // first time) does that. Nothing ran; one new check settles it.
        if (attempt === 0 && REFUSED_BEFORE_START.has(failureReason(error) ?? "")) continue;
        // An older companion answers a method it does not know as an invalid request. Once the API has answered, that is a real failure.
        known = this.companion;
        if (known.readiness === true || failureReason(error) !== "INVALID_REQUEST") throw error;
        known.readiness = false;
      }
    }
    if (known.readiness === false) await this.client.request(this.provider, "status", null, take);
    if (!status) throw new Error("Seatline did not return provider status");
    if (answered && answered.generation !== this.link?.generation()) throw new Error("Seatline reconnected while checking readiness. Try again.");
    const seen = status as Status;
    return { status: seen, observedAt: Date.now() - (seen.readiness?.age_ms ?? 0) };
  }

  private latest: { at: number; fresh?: boolean; observedAt?: number; promise: Promise<Reading> } | undefined;

  /**
   * The provider's state, reusing an answer no older than `reuseMs`, including one still on its way, so concurrent callers share a
   * single request. An answer whose evidence is already as old as Seatline's own window is not reused: two layers of caching must not
   * add up to more than one. `FRESH` asks for a new check whatever was asked before; concurrent `FRESH` callers share one.
   */
  private state(reuseMs: number): Promise<Reading> {
    const now = Date.now();
    const kept = this.latest;
    if (reuseMs >= 0 && kept && now - kept.at <= reuseMs && (kept.observedAt === undefined || now - kept.observedAt <= READINESS_MAX_AGE_MS)) return kept.promise;
    // Callers that all want a new check, at the same moment, share one.
    if (reuseMs < 0 && kept?.fresh && kept.observedAt === undefined) return kept.promise;
    const entry: NonNullable<SeatlineProvider["latest"]> = { at: now, fresh: reuseMs < 0, promise: this.fetchState(reuseMs < 0 ? NEW_CHECK : CACHED) };
    this.latest = entry;
    entry.promise.then(reading => { entry.observedAt = reading.observedAt; }, () => { if (this.latest === entry) this.latest = undefined; });
    return entry.promise;
  }

  /** `fresh`: the user asked (a retry after signing in, say), so do not reuse an earlier answer here or in Seatline. */
  async status(options: { fresh?: boolean } = {}): Promise<ProviderStatus> {
    try {
      const { status: state } = await this.state(options.fresh ? FRESH : STATE_REUSE_MS);
      return { id: this.id, label: this.label, available: state.availability === "available",
        connected: this.usable(state),
        authMode: state.sign_in,
        message: unusableReason(this.provider, this.label, state, mode => this.acceptedSignIn(mode)) };
    } catch (error) {
      return { id: this.id, label: this.label, available: false, connected: false,
        message: error instanceof Error ? error.message : "Seatline unavailable" };
    }
  }

  async listModels(options: { fresh?: boolean } = {}): Promise<ModelRef[]> {
    const { status: state } = await this.state(options.fresh ? FRESH : STATE_REUSE_MS);
    if (state.authentication !== "authenticated" || !this.acceptedSignIn(state.sign_in)) return [];
    return [{ provider: this.id, model: DEFAULT_MODEL, label: `${this.label} (provider default)`, source: "subscription" as const, isDefault: true },
      ...state.models.map(model => ({ provider: this.id, model: model.id, label: model.label, source: "subscription" as const }))];
  }

  async limits(): Promise<ProviderLimitSnapshot> {
    return { provider: this.id, available: false, message: "The Seatline CLI adapter does not expose a structured subscription-limit snapshot." };
  }

  private preparedAt = -Infinity;

  /**
   * Gets the provider ready ahead of a run the user is likely to start: Seatline checks readiness and resolves the executable, with no
   * prompt and no model turn. Best effort: it never throws, reserves at most one optional slot while leaving a foreground slot free, at most
   * every ten seconds, and not at all for a companion without the readiness API. What it learns is kept for the run that follows.
   */
  async prepare(): Promise<"prepared" | "skipped"> {
    const now = Date.now(), known = this.companion;
    if (known.readiness === false || now - this.preparedAt < PREPARE_INTERVAL_MS || this.link?.congested()) return "skipped";
    if (!this.client.tryPrepare) return "skipped";
    const previousPreparation = this.preparedAt;
    this.preparedAt = now;
    let status: Status | undefined;
    let answered: ReturnType<typeof capability> | undefined;
    try {
      const admitted = await this.client.tryPrepare(this.provider, CACHED, event => { if (event.type === "status") { status = event.status; answered = this.companion; } });
      if (!admitted) { this.preparedAt = previousPreparation; return "skipped"; }
      if (answered && answered.generation !== this.link?.generation()) return "skipped";
      (answered ?? this.companion).readiness = true;
    } catch (error) {
      const answered = this.companion;
      if (answered.readiness !== true && failureReason(error) === "INVALID_REQUEST") answered.readiness = false;
      return "skipped";
    }
    const seen = status as Status | undefined;
    if (seen && (!this.latest || this.latest.at <= now)) {
      const observedAt = Date.now() - (seen.readiness?.age_ms ?? 0);
      this.latest = { at: Date.now(), observedAt, promise: Promise.resolve({ status: seen, observedAt }) };
    }
    return "prepared";
  }

  async generate(request: ProviderRequest, emit?: ProviderEventSink): Promise<ProviderResponse> {
    const startedAt = Date.now();
    // A recent answer is enough to start a step. If it says the provider is not usable, ask again, as a new check: the user may have
    // signed in since, or changed account (Seatline caches a signed-in result of any account type).
    let reading = await this.state(PREFLIGHT_REUSE_MS);
    if (!this.usable(reading.status)) reading = await this.state(FRESH);
    if (request.signal?.aborted) throw new Error("Run cancelled");
    if (!this.usable(reading.status)) {
      throw new Error("A verified subscription sign-in is required. Sign in to your provider CLI.");
    }
    const turn = {
      system: [request.system, ...request.messages.filter(m => m.role === "system").map(m => m.content)].filter(Boolean).join("\n\n") || null,
      messages: request.messages.filter(m => m.role !== "system").map(m => ({ role: m.role, text: m.content })),
      model: request.model === DEFAULT_MODEL ? null : request.model, tools: "none", session: "ephemeral", continuation: null, cleanup_group: null,
    };
    for (let attempt = 0; ; attempt++) {
      let content = "";
      const onEvent = (event: SeatlineEvent) => {
        // Waiting for one of the companion's slots: tell the run, which counts it as activity, not a stall.
        if (event.type === "queued") emit?.({ type: "status", message: "Waiting for your Seatline companion to finish other requests" });
        // The status a checked send reports is the one it ran under; Conclave's own account rule applies to it too.
        if (event.type === "status" && !this.acceptedSignIn(event.status?.sign_in)) throw new Error("Provider sign-in changed; subscription account required");
        if (event.type === "delta" && event.text) { content += event.text; emit?.({ type: "text_delta", delta: event.text }); }
        if (event.type === "usage") emit?.({ type: "usage", inputTokens: event.usage?.input_tokens, outputTokens: event.usage?.output_tokens });
      };
      try {
        // Older companions must refuse this distinct method: an unknown
        // parameter on send_ready could otherwise be silently ignored.
        if (!this.companion.readiness) throw new Error("Update your Seatline companion to enforce the subscription sign-in policy.");
        await this.client.request(this.provider, "send_ready_with_policy", {
          turn: { ...turn, check_sign_in: false }, freshness: CACHED,
          allowed_sign_in: this.id === "google" ? ["subscription", "cloud"] : ["subscription"],
        }, onEvent, request.signal);
      } catch (error) {
        // Whatever failed, the earlier answer about this provider may no longer hold (a turn that fails to authenticate also makes
        // Seatline drop its own), so the next step asks again.
        this.latest = undefined;
        if (["INVALID_REQUEST", "READINESS_UNSUPPORTED"].includes(failureReason(error) ?? "")) {
          throw new Error("Update your Seatline companion to enforce the subscription sign-in policy.");
        }
        // Seatline refused before it started a turn because the evidence changed or lapsed: nothing ran, so one more attempt is safe, from a
        // new check, which the send then reuses (it is the cached evidence now).
        if (attempt === 0 && !request.signal?.aborted && REFUSED_BEFORE_START.has(failureReason(error) ?? "")) {
          reading = await this.state(FRESH);
          if (!this.usable(reading.status)) throw new Error("A verified subscription sign-in is required. Sign in to your provider CLI.");
          continue;
        }
        throw error;
      }
      if (!content.trim()) throw new Error("Provider completed without a text response");
      return { provider: this.id, model: request.model, content, latencyMs: Date.now() - startedAt };
    }
  }
}
