from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing target: {label}")
    return text.replace(old, new, 1)


p = Path("apps/server/src/orchestrator.ts")
s = p.read_text()
s = replace_once(
    s,
    '''        let activeDebaters = independent.map((step) => step.model);\n\n        for (''',
    '''        let activeDebaters = independent.map((step) => step.model);\n        const skippedInitialDebaters = request.participants.length - activeDebaters.length;\n        if (skippedInitialDebaters > 0) {\n          context.plannedCallsRemaining = Math.max(\n            0,\n            context.plannedCallsRemaining - skippedInitialDebaters * maxRounds,\n          );\n        }\n\n        for (''',
    "initial debate reservation reclaim",
)
s = replace_once(
    s,
    '''        ) {\n          this.throwIfCancelled(context);\n          const settled = await this.settleSteps(''',
    '''        ) {\n          this.throwIfCancelled(context);\n          const roundDebaterCount = activeDebaters.length;\n          const settled = await this.settleSteps(''',
    "round debater count",
)
s = replace_once(
    s,
    '''          failures.push(...settled.failures);\n          if (settled.steps.length === 0) break;\n\n          debateSteps.push(...settled.steps);\n          activeDebaters = settled.steps.map((step) => step.model);\n          previousIds = settled.steps.map((step) => step.id);''',
    '''          failures.push(...settled.failures);\n          const nextDebaters = settled.steps.map((step) => step.model);\n          const droppedDebaters = roundDebaterCount - nextDebaters.length;\n          const remainingRounds = maxRounds - round - 1;\n          if (droppedDebaters > 0 && remainingRounds > 0) {\n            context.plannedCallsRemaining = Math.max(\n              0,\n              context.plannedCallsRemaining - droppedDebaters * remainingRounds,\n            );\n          }\n          activeDebaters = nextDebaters;\n          if (settled.steps.length === 0) break;\n\n          debateSteps.push(...settled.steps);\n          previousIds = settled.steps.map((step) => step.id);''',
    "per-round debate reservation reclaim",
)
p.write_text(s)


p = Path("apps/server/src/orchestrator.test.ts")
s = p.read_text()
s = replace_once(
    s,
    '''class AllAnswersFailProvider extends MockProvider {\n  calls: string[] = [];\n\n  override async generate(request: ProviderRequest) {\n    this.calls.push(request.model);\n    if (request.model !== "mock-finalizer") throw new Error("provider authentication unavailable");\n    return super.generate(request);\n  }\n}\n''',
    '''class AllAnswersFailProvider extends MockProvider {\n  calls: string[] = [];\n\n  override async generate(request: ProviderRequest) {\n    this.calls.push(request.model);\n    if (request.model !== "mock-finalizer") throw new Error("provider authentication unavailable");\n    return super.generate(request);\n  }\n}\n\nclass DebateReclaimProvider extends MockProvider {\n  roundOneGrokAttempts = 0;\n\n  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {\n    const latest = request.messages.at(-1)?.content ?? "";\n    if (request.model === "mock-claude" && latest === "Reclaim debate slots") {\n      throw new Error("provider authentication unavailable");\n    }\n    if (request.model === "mock-grok" && latest.startsWith("You are in debate round 1.")) {\n      this.roundOneGrokAttempts += 1;\n      if (this.roundOneGrokAttempts === 1) {\n        throw new Error("temporary connection unavailable");\n      }\n    }\n    return super.generate(request);\n  }\n}\n''',
    "debate reclaim provider",
)
anchor = '''  it("does not invoke a finalizer when every independent answer fails", async () => {'''
test = '''  it("reclaims skipped debate slots so surviving debaters can still retry", async () => {\n    const provider = new DebateReclaimProvider();\n    const instance = new Orchestrator(new Map([[provider.id, provider]]));\n    const result = await instance.run({\n      mode: "debate",\n      prompt: "Reclaim debate slots",\n      participants,\n      budget: { maxCalls: 10, maxRounds: 2 },\n    });\n\n    expect(provider.roundOneGrokAttempts).toBe(2);\n    expect(result.steps.filter(step => step.kind === "critique")).toHaveLength(4);\n    expect(result.steps.at(-1)?.kind).toBe("synthesis");\n  });\n\n'''
if anchor not in s:
    raise SystemExit("missing target: debate reclaim test anchor")
s = s.replace(anchor, test + anchor, 1)
p.write_text(s)


p = Path("apps/server/src/state/run-inspection.ts")
s = p.read_text()
s = replace_once(
    s,
    '''  const steps = new Map<string, RunStepInspection>();\n  let usage = emptyRunUsage();''',
    '''  const steps = new Map<string, RunStepInspection>();\n  const retryUsageBase = new Map<string, { inputTokens: number; outputTokens: number }>();\n  let usage = emptyRunUsage();''',
    "retry usage base map",
)
s = replace_once(
    s,
    '''      existing.attempts = event.attempt;\n      existing.error = event.message;\n      steps.set(event.stepId, existing);''',
    '''      existing.attempts = event.attempt;\n      existing.error = event.message;\n      retryUsageBase.set(event.stepId, {\n        inputTokens: existing.inputTokens ?? 0,\n        outputTokens: existing.outputTokens ?? 0,\n      });\n      steps.set(event.stepId, existing);''',
    "retry usage snapshot",
)
s = replace_once(
    s,
    '''      if (event.inputTokens !== undefined) step.inputTokens = event.inputTokens;\n      if (event.outputTokens !== undefined) step.outputTokens = event.outputTokens;\n      steps.set(event.stepId, step);''',
    '''      const base = retryUsageBase.get(event.stepId) ?? { inputTokens: 0, outputTokens: 0 };\n      if (event.inputTokens !== undefined) step.inputTokens = base.inputTokens + event.inputTokens;\n      if (event.outputTokens !== undefined) step.outputTokens = base.outputTokens + event.outputTokens;\n      steps.set(event.stepId, step);''',
    "cumulative retry usage",
)
p.write_text(s)


p = Path("apps/server/src/state/run-inspection.test.ts")
s = p.read_text()
anchor = '''  it("marks the originating workflow step failed and aborted siblings cancelled", async () => {'''
test = '''  it("accumulates per-step token usage across retry attempts", async () => {\n    const store = await makeStore();\n    const created = await store.createRun({\n      mode: "single",\n      prompt: "Retry usage",\n      participants: [model],\n      budget: { maxCalls: 2, maxRounds: 1 },\n    });\n    const runId = created.run.id;\n    const result: OrchestrationResult = {\n      mode: "single",\n      steps: [{ id: "answer-1", kind: "answer", model, content: "Recovered", dependsOn: [] }],\n      final: "Recovered",\n    };\n    const records: RunEventRecord[] = [\n      { seq: 1, attempt: 1, at: "2026-09-13T00:10:00.000Z", event: { type: "run_started", runId, mode: "single" } },\n      { seq: 2, attempt: 1, at: "2026-09-13T00:10:01.000Z", event: { type: "step_started", runId, stepId: "answer-1", kind: "answer", model } },\n      { seq: 3, attempt: 1, at: "2026-09-13T00:10:02.000Z", event: { type: "usage", runId, stepId: "answer-1", inputTokens: 10, outputTokens: 4 } },\n      { seq: 4, attempt: 1, at: "2026-09-13T00:10:03.000Z", event: { type: "step_retrying", runId, stepId: "answer-1", attempt: 2, message: "temporary connection unavailable" } },\n      { seq: 5, attempt: 1, at: "2026-09-13T00:10:04.000Z", event: { type: "usage", runId, stepId: "answer-1", inputTokens: 6, outputTokens: 1 } },\n      { seq: 6, attempt: 1, at: "2026-09-13T00:10:05.000Z", event: { type: "usage", runId, stepId: "answer-1", inputTokens: 6, outputTokens: 3 } },\n      { seq: 7, attempt: 1, at: "2026-09-13T00:10:06.000Z", event: { type: "step_completed", runId, step: result.steps[0] } },\n      { seq: 8, attempt: 1, at: "2026-09-13T00:10:07.000Z", event: { type: "run_completed", runId, result } },\n    ];\n    for (const record of records) await store.appendRunEvent(record);\n    await store.completeRun(runId, result);\n\n    const run = await store.getRun(runId);\n    const inspection = await inspectRun(store, run!);\n    expect(inspection.attempts[0]?.steps[0]).toMatchObject({\n      id: "answer-1",\n      status: "completed",\n      attempts: 2,\n      inputTokens: 16,\n      outputTokens: 7,\n    });\n  });\n\n'''
if anchor not in s:
    raise SystemExit("missing target: inspection retry usage test anchor")
s = s.replace(anchor, test + anchor, 1)
p.write_text(s)


p = Path("apps/web/src/main.tsx")
s = p.read_text()
s = replace_once(
    s,
    '''    if (streamEvent.type === "text_delta") {\n      setLiveSteps(current => current.map(step => step.id === streamEvent.stepId\n        ? { ...step, content: step.content + streamEvent.delta }\n        : step));\n      return;\n    }\n''',
    '''    if (streamEvent.type === "step_failed") {\n      setCompletedStepIds(current => current.filter(id => id !== streamEvent.failure.stepId));\n      setLiveSteps(current => current.filter(step => step.id !== streamEvent.failure.stepId));\n      return;\n    }\n\n    if (streamEvent.type === "text_delta") {\n      setLiveSteps(current => current.map(step => step.id === streamEvent.stepId\n        ? { ...step, content: step.content + streamEvent.delta }\n        : step));\n      return;\n    }\n''',
    "live failed-step handling",
)
p.write_text(s)
