from pathlib import Path

root = Path('.')

# --- orchestrator.ts ---
path = root / 'apps/server/src/orchestrator.ts'
text = path.read_text()
text = text.replace(
'''  ProviderAdapter,\n  ProviderStreamEvent,\n''',
'''  ProviderAdapter,\n  ProviderResponse,\n  ProviderStreamEvent,\n''',
1,
)
text = text.replace(
'''type RunOptions = {\n  runId?: string;\n  emit?: OrchestrationEventSink;\n  signal?: AbortSignal;\n};\n''',
'''type RunOptions = {\n  runId?: string;\n  emit?: OrchestrationEventSink;\n  signal?: AbortSignal;\n};\n\ntype OrchestratorOptions = {\n  stepStallTimeoutMs?: number;\n};\n\nconst DEFAULT_STEP_STALL_TIMEOUT_MS = 180_000;\n''',
1,
)
text = text.replace(
'''function cancelledError() {\n  const error = new Error("Run cancelled by user");\n  error.name = "AbortError";\n  return error;\n}\n\nfunction isRetryableStepError(error: unknown) {\n  if (isRateLimitError(error)) return false;\n''',
'''function cancelledError() {\n  const error = new Error("Run cancelled by user");\n  error.name = "AbortError";\n  return error;\n}\n\nclass StepStallError extends Error {\n  constructor(readonly timeoutMs: number) {\n    super(`Provider step stalled for ${timeoutMs}ms without progress`);\n    this.name = "StepStallError";\n  }\n}\n\nfunction isRetryableStepError(error: unknown) {\n  if (error instanceof StepStallError) return true;\n  if (isRateLimitError(error)) return false;\n''',
1,
)
text = text.replace(
'''export class Orchestrator {\n  constructor(private readonly providers: Map<string, ProviderAdapter>) {}\n''',
'''export class Orchestrator {\n  private readonly stepStallTimeoutMs: number;\n\n  constructor(\n    private readonly providers: Map<string, ProviderAdapter>,\n    options: OrchestratorOptions = {},\n  ) {\n    const configured = options.stepStallTimeoutMs\n      ?? Number(process.env.CONCLAVE_STEP_STALL_TIMEOUT_MS ?? DEFAULT_STEP_STALL_TIMEOUT_MS);\n    if (!Number.isInteger(configured) || configured < 10) {\n      throw new Error("stepStallTimeoutMs must be an integer of at least 10ms");\n    }\n    this.stepStallTimeoutMs = configured;\n  }\n''',
1,
)
marker = '''  private async executeStep(\n    spec: StepSpec,\n    context: RunContext,\n    options: ExecuteStepOptions = {},\n  ) {\n'''
watchdog = '''  private async generateWithStallWatchdog(\n    spec: StepSpec,\n    context: RunContext,\n    onEvent: (event: ProviderStreamEvent) => void,\n  ): Promise<ProviderResponse> {\n    const adapter = this.adapterFor(spec.model);\n    const controller = new AbortController();\n    const parentSignal = context.signal;\n\n    return new Promise<ProviderResponse>((resolve, reject) => {\n      let settled = false;\n      let timer: ReturnType<typeof setTimeout> | undefined;\n\n      const clearWatchdog = () => {\n        if (timer !== undefined) clearTimeout(timer);\n        timer = undefined;\n      };\n      const cleanup = () => {\n        clearWatchdog();\n        parentSignal?.removeEventListener("abort", onParentAbort);\n      };\n      const resolveOnce = (response: ProviderResponse) => {\n        if (settled) return;\n        settled = true;\n        cleanup();\n        resolve(response);\n      };\n      const rejectOnce = (error: unknown) => {\n        if (settled) return;\n        settled = true;\n        cleanup();\n        reject(error);\n      };\n      const armWatchdog = () => {\n        clearWatchdog();\n        timer = setTimeout(() => {\n          if (settled) return;\n          const error = new StepStallError(this.stepStallTimeoutMs);\n          settled = true;\n          cleanup();\n          reject(error);\n          controller.abort(error);\n        }, this.stepStallTimeoutMs);\n      };\n      const onParentAbort = () => {\n        if (settled) return;\n        const error = cancelledError();\n        settled = true;\n        cleanup();\n        reject(error);\n        controller.abort(error);\n      };\n\n      if (parentSignal?.aborted) {\n        onParentAbort();\n        return;\n      }\n      parentSignal?.addEventListener("abort", onParentAbort, { once: true });\n      armWatchdog();\n\n      void adapter.generate(\n        {\n          model: spec.model.model,\n          messages: [\n            ...(spec.history ?? []),\n            { role: "user", content: spec.prompt },\n          ],\n          signal: controller.signal,\n        },\n        (event) => {\n          if (settled) return;\n          armWatchdog();\n          onEvent(event);\n        },\n      ).then(resolveOnce, rejectOnce);\n    });\n  }\n\n'''
if marker not in text:
    raise SystemExit('executeStep marker not found')
text = text.replace(marker, watchdog + marker, 1)
old_generate = '''        const response = await this.adapterFor(spec.model).generate(\n          {\n            model: spec.model.model,\n            messages: [\n              ...(spec.history ?? []),\n              { role: "user", content: spec.prompt },\n            ],\n            signal: context.signal,\n          },\n          (event) => {\n            if (event.type === "text_delta" && event.delta) emittedText = true;\n            this.mapProviderEvent(context, spec.id, event);\n          },\n        );\n'''
new_generate = '''        const response = await this.generateWithStallWatchdog(\n          spec,\n          context,\n          (event) => {\n            if (event.type === "text_delta" && event.delta) emittedText = true;\n            this.mapProviderEvent(context, spec.id, event);\n          },\n        );\n'''
if old_generate not in text:
    raise SystemExit('provider generate block not found')
text = text.replace(old_generate, new_generate, 1)
path.write_text(text)

# --- orchestrator.test.ts ---
path = root / 'apps/server/src/orchestrator.test.ts'
text = path.read_text()
insert_before = '''class AbortAwareProvider extends MockProvider {\n'''
stall_class = '''class StallThenRecoverProvider extends MockProvider {\n  calls = 0;\n  aborted = 0;\n\n  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {\n    this.calls += 1;\n    if (this.calls > 1) return super.generate(request);\n\n    emit?.({ type: "text_delta", delta: "partial-before-stall" });\n    return new Promise<never>((_resolve, reject) => {\n      const abort = () => {\n        this.aborted += 1;\n        const error = new Error("stalled attempt aborted");\n        error.name = "AbortError";\n        reject(error);\n      };\n      if (request.signal?.aborted) return abort();\n      request.signal?.addEventListener("abort", abort, { once: true });\n    });\n  }\n}\n\n'''
if insert_before not in text:
    raise SystemExit('AbortAwareProvider marker not found')
text = text.replace(insert_before, stall_class + insert_before, 1)
rate_test = '''  it("normalizes provider rate-limit failures", async () => {\n'''
stall_test = '''  it("aborts a stalled provider attempt and retries only that step", async () => {\n    const stalled = new StallThenRecoverProvider();\n    const instance = new Orchestrator(\n      new Map([[stalled.id, stalled]]),\n      { stepStallTimeoutMs: 30 },\n    );\n    const events: OrchestrationStreamEvent[] = [];\n\n    const result = await instance.run({\n      mode: "single",\n      prompt: "Recover from a stalled runtime",\n      participants: [participants[0]],\n      budget: { maxCalls: 2, maxRounds: 1 },\n    }, {\n      runId: "stall-retry-test",\n      emit: event => events.push(event),\n    });\n\n    expect(stalled.calls).toBe(2);\n    expect(stalled.aborted).toBe(1);\n    expect(events.filter(event => event.type === "step_retrying")).toHaveLength(1);\n    expect(events.find(event => event.type === "step_retrying")?.message).toMatch(/stalled/i);\n    expect(result.final).toContain("Recover from a stalled runtime");\n  });\n\n'''
if rate_test not in text:
    raise SystemExit('rate limit test marker not found')
text = text.replace(rate_test, stall_test + rate_test, 1)
path.write_text(text)

# --- run-manager.test.ts ---
path = root / 'apps/server/src/state/run-manager.test.ts'
text = path.read_text()
insert_before = '''afterEach(async () => {\n'''
provider_class = '''class ReplayStallProvider extends MockProvider {\n  calls = 0;\n  aborted = 0;\n\n  override async generate(request: ProviderRequest, emit?: (event: { type: "text_delta"; delta: string }) => void) {\n    this.calls += 1;\n    if (this.calls > 1) return super.generate(request);\n\n    emit?.({ type: "text_delta", delta: "stale-partial" });\n    return new Promise<never>((_resolve, reject) => {\n      const abort = () => {\n        this.aborted += 1;\n        const error = new Error("replay stall aborted");\n        error.name = "AbortError";\n        reject(error);\n      };\n      if (request.signal?.aborted) return abort();\n      request.signal?.addEventListener("abort", abort, { once: true });\n    });\n  }\n}\n\n'''
if insert_before not in text:
    raise SystemExit('afterEach marker not found')
text = text.replace(insert_before, provider_class + insert_before, 1)
old_make = '''async function makeManager(provider: MockProvider = new MockProvider()) {\n  const dir = await mkdtemp(join(tmpdir(), "conclave-manager-"));\n  tempDirs.push(dir);\n  const orchestrator = new Orchestrator(new Map([[provider.id, provider]]));\n'''
new_make = '''async function makeManager(\n  provider: MockProvider = new MockProvider(),\n  stepStallTimeoutMs?: number,\n) {\n  const dir = await mkdtemp(join(tmpdir(), "conclave-manager-"));\n  tempDirs.push(dir);\n  const orchestrator = new Orchestrator(\n    new Map([[provider.id, provider]]),\n    { stepStallTimeoutMs },\n  );\n'''
if old_make not in text:
    raise SystemExit('makeManager target not found')
text = text.replace(old_make, new_make, 1)
validation_test = '''  it("rejects invalid server-side budget values before creating a run", async () => {\n'''
replay_test = '''  it("replays stalled-step recovery from a cursor without gaps or duplicates", async () => {\n    const provider = new ReplayStallProvider();\n    const { manager } = await makeManager(provider, 80);\n    const started = await manager.start({\n      request: {\n        mode: "single",\n        prompt: "Recover and replay",\n        participants: [participant],\n        budget: { maxCalls: 2, maxRounds: 1 },\n      },\n    });\n\n    let firstDeltaSeq = 0;\n    for (let attempt = 0; attempt < 100 && firstDeltaSeq === 0; attempt += 1) {\n      const records = await manager.events(started.runId);\n      firstDeltaSeq = records.find(record => record.event.type === "text_delta")?.seq ?? 0;\n      if (!firstDeltaSeq) await new Promise(resolve => setTimeout(resolve, 2));\n    }\n    expect(firstDeltaSeq).toBeGreaterThan(0);\n\n    const completed = await waitForTerminal(manager, started.runId);\n    expect(completed.status).toBe("completed");\n    expect(provider.calls).toBe(2);\n    expect(provider.aborted).toBe(1);\n\n    const replay = await manager.events(started.runId, firstDeltaSeq);\n    const replayAgain = await manager.events(started.runId, firstDeltaSeq);\n    expect(replay.map(record => record.seq)).toEqual(replayAgain.map(record => record.seq));\n    expect(replay[0]?.seq).toBe(firstDeltaSeq + 1);\n    expect(replay.some(record => record.event.type === "step_retrying")).toBe(true);\n    expect(replay.at(-1)?.event.type).toBe("run_completed");\n\n    const full = await manager.events(started.runId);\n    expect(full.map(record => record.seq)).toEqual(full.map((_, index) => index + 1));\n  });\n\n'''
if validation_test not in text:
    raise SystemExit('validation test marker not found')
text = text.replace(validation_test, replay_test + validation_test, 1)
path.write_text(text)

# --- README.md ---
path = root / 'README.md'
text = path.read_text()
needle = '''Conclave exposes structured ChatGPT subscription-window usage when Codex makes `account/rateLimits/read` available. Claude Code and Grok Build ACP do not currently expose equivalent stable structured subscription-limit snapshots to Conclave, so the UI labels those snapshots unavailable rather than inventing estimates. Runtime rate-limit/quota errors are normalized and persisted with the affected run.\n'''
replacement = needle + '''\nEach provider step also has an inactivity watchdog. By default, a call that produces no provider progress event for **180 seconds** is treated as stalled, its local runtime call is aborted, and the step is eligible for the same single bounded retry used for transient transport failures when call-budget headroom remains. Any provider event resets the watchdog, so long-running calls can continue as long as they are still making observable progress. Set `CONCLAVE_STEP_STALL_TIMEOUT_MS` to a positive integer of at least 10 milliseconds to tune the inactivity window for local testing or unusually slow runtimes.\n'''
if needle not in text:
    raise SystemExit('README watchdog insertion point not found')
text = text.replace(needle, replacement, 1)
text = text.replace(
'''9. Web-first robustness: partial-provider failure handling, step-level retry, stalled-provider recovery, reconnect/reload stress coverage, and stronger lifecycle integration tests\n''',
'''9. ✅ Web-first robustness: partial-provider failure handling, step-level retry, stalled-provider recovery, reconnect/reload stress coverage, and stronger lifecycle integration tests\n''',
1,
)
path.write_text(text)
