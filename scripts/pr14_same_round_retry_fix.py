from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing target: {label}")
    return text.replace(old, new, 1)


p = Path("apps/server/src/orchestrator.ts")
s = p.read_text()

s = replace_once(
    s,
    '''type RunContext = {\n  runId: string;\n  emit?: OrchestrationEventSink;\n  signal?: AbortSignal;\n  budget?: RunBudget;\n  usage: RunUsage;\n  stepUsage: Map<string, { inputTokens: number; outputTokens: number }>;\n  plannedCallsRemaining: number;\n};\n''',
    '''type RunContext = {\n  runId: string;\n  emit?: OrchestrationEventSink;\n  signal?: AbortSignal;\n  budget?: RunBudget;\n  usage: RunUsage;\n  stepUsage: Map<string, { inputTokens: number; outputTokens: number }>;\n  plannedCallsRemaining: number;\n};\n\ntype ExecuteStepOptions = {\n  startingAttempt?: number;\n  announced?: boolean;\n  deferRetry?: boolean;\n};\n''',
    "execute options type",
)

s = replace_once(
    s,
    '''class StepExecutionError extends Error {\n  constructor(readonly failure: StepFailure) {\n    super(failure.message);\n    this.name = "StepExecutionError";\n  }\n}\n''',
    '''class StepExecutionError extends Error {\n  constructor(readonly failure: StepFailure) {\n    super(failure.message);\n    this.name = "StepExecutionError";\n  }\n}\n\nclass DeferredStepRetryError extends StepExecutionError {\n  constructor(failure: StepFailure) {\n    super(failure);\n    this.name = "DeferredStepRetryError";\n  }\n}\n''',
    "deferred retry error",
)

s = replace_once(
    s,
    '''  private async executeStep(spec: StepSpec, context: RunContext) {\n    this.throwIfCancelled(context);\n    let attempt = 0;\n    let announced = false;\n''',
    '''  private async executeStep(\n    spec: StepSpec,\n    context: RunContext,\n    options: ExecuteStepOptions = {},\n  ) {\n    this.throwIfCancelled(context);\n    let attempt = options.startingAttempt ?? 0;\n    let announced = options.announced ?? false;\n''',
    "execute step options",
)

s = replace_once(
    s,
    '''        const retryable = isRetryableStepError(error);\n        const hasRetryHeadroom =\n          maxCalls === undefined ||\n          maxCalls - context.usage.callsStarted > context.plannedCallsRemaining;\n''',
    '''        const retryable = isRetryableStepError(error);\n        if (retryable && attempt < 2 && options.deferRetry) {\n          throw new DeferredStepRetryError({\n            stepId: spec.id,\n            kind: spec.kind,\n            model: spec.model,\n            message: errorMessage(error),\n            retryable: true,\n            attempts: attempt,\n          });\n        }\n        const hasRetryHeadroom =\n          maxCalls === undefined ||\n          maxCalls - context.usage.callsStarted > context.plannedCallsRemaining;\n''',
    "defer retry branch",
)

anchor = '''  private buildResult(\n'''
helper = '''  private async settleRetryAwareBatch(\n    specs: StepSpec[],\n    context: RunContext,\n    futureCallsPerTerminalFailure: number,\n    requireSuccess = true,\n  ) {\n    const settled = await Promise.allSettled(\n      specs.map((spec) => this.executeStep(spec, context, { deferRetry: true })),\n    );\n    this.throwIfCancelled(context);\n\n    const stepsByIndex = new Map<number, OrchestrationStep>();\n    const failures: StepFailure[] = [];\n    const deferred: Array<{ index: number; spec: StepSpec; failure: StepFailure }> = [];\n    const reclaimFutureCalls = () => {\n      if (futureCallsPerTerminalFailure <= 0) return;\n      context.plannedCallsRemaining = Math.max(\n        0,\n        context.plannedCallsRemaining - futureCallsPerTerminalFailure,\n      );\n    };\n\n    for (let index = 0; index < settled.length; index += 1) {\n      const item = settled[index];\n      if (item.status === "fulfilled") {\n        stepsByIndex.set(index, item.value);\n        continue;\n      }\n\n      if (item.reason instanceof DeferredStepRetryError) {\n        deferred.push({ index, spec: specs[index], failure: item.reason.failure });\n        continue;\n      }\n\n      const failure = this.failureFrom(item.reason);\n      if (!failure) throw item.reason;\n      failures.push(failure);\n      reclaimFutureCalls();\n    }\n\n    for (const item of deferred) {\n      const maxCalls = context.budget?.maxCalls;\n      const hasRetryHeadroom =\n        maxCalls === undefined ||\n        maxCalls - context.usage.callsStarted > context.plannedCallsRemaining;\n\n      if (!hasRetryHeadroom) {\n        context.emit?.({\n          type: "step_failed",\n          runId: context.runId,\n          failure: item.failure,\n        });\n        failures.push(item.failure);\n        reclaimFutureCalls();\n        continue;\n      }\n\n      context.stepUsage.delete(item.spec.id);\n      context.emit?.({\n        type: "step_retrying",\n        runId: context.runId,\n        stepId: item.spec.id,\n        attempt: 2,\n        message: item.failure.message,\n      });\n\n      try {\n        const step = await this.executeStep(item.spec, context, {\n          startingAttempt: 1,\n          announced: true,\n        });\n        stepsByIndex.set(item.index, step);\n      } catch (error) {\n        const failure = this.failureFrom(error);\n        if (!failure) throw error;\n        failures.push(failure);\n        reclaimFutureCalls();\n      }\n    }\n\n    const steps = specs\n      .map((_, index) => stepsByIndex.get(index))\n      .filter((step): step is OrchestrationStep => Boolean(step));\n\n    if (requireSuccess && steps.length === 0) {\n      const detail = failures\n        .map((failure) => `${failure.model.label}: ${failure.message}`)\n        .join("; ");\n      throw new Error(\n        `All parallel model steps failed${detail ? `: ${detail}` : "."}`,\n      );\n    }\n\n    return { steps, failures };\n  }\n\n'''
if anchor not in s:
    raise SystemExit("missing target: retry-aware helper anchor")
s = s.replace(anchor, helper + anchor, 1)

s = replace_once(
    s,
    '''      const independentOutcome = await this.independentAnswers(\n        request,\n        context,\n      );\n''',
    '''      const independentOutcome =\n        request.mode === "debate"\n          ? await this.settleRetryAwareBatch(\n              request.participants.map((model, index) => ({\n                id: makeStepId("answer", index),\n                kind: "answer" as const,\n                model,\n                prompt: request.prompt,\n                history: request.history,\n              })),\n              context,\n              this.debateRounds(request),\n            )\n          : await this.independentAnswers(request, context);\n''',
    "debate independent barrier",
)

s = replace_once(
    s,
    '''        let previousIds = independentIds;\n        let activeDebaters = independent.map((step) => step.model);\n        const skippedInitialDebaters = request.participants.length - activeDebaters.length;\n        if (skippedInitialDebaters > 0) {\n          context.plannedCallsRemaining = Math.max(\n            0,\n            context.plannedCallsRemaining - skippedInitialDebaters * maxRounds,\n          );\n        }\n''',
    '''        let previousIds = independentIds;\n        let activeDebaters = independent.map((step) => step.model);\n''',
    "remove post-hoc initial reclaim",
)

s = replace_once(
    s,
    '''          this.throwIfCancelled(context);\n          const roundDebaterCount = activeDebaters.length;\n          const settled = await this.settleSteps(\n''',
    '''          this.throwIfCancelled(context);\n          const remainingRounds = maxRounds - round - 1;\n          const settled = await this.settleRetryAwareBatch(\n''',
    "retry-aware debate round",
)

s = replace_once(
    s,
    '''            context,\n            false,\n          );\n          failures.push(...settled.failures);\n          const nextDebaters = settled.steps.map((step) => step.model);\n          const droppedDebaters = roundDebaterCount - nextDebaters.length;\n          const remainingRounds = maxRounds - round - 1;\n          if (droppedDebaters > 0 && remainingRounds > 0) {\n            context.plannedCallsRemaining = Math.max(\n              0,\n              context.plannedCallsRemaining - droppedDebaters * remainingRounds,\n            );\n          }\n          activeDebaters = nextDebaters;\n''',
    '''            context,\n            remainingRounds,\n            false,\n          );\n          failures.push(...settled.failures);\n          activeDebaters = settled.steps.map((step) => step.model);\n''',
    "remove post-hoc round reclaim",
)

p.write_text(s)


p = Path("apps/server/src/orchestrator.test.ts")
s = p.read_text()
s = replace_once(
    s,
    '''    if (request.model === "mock-claude" && latest === "Reclaim debate slots") {\n      throw new Error("provider authentication unavailable");\n    }\n''',
    '''    if (\n      request.model === "mock-claude" &&\n      latest.startsWith("You are in debate round 1.")\n    ) {\n      throw new Error("provider authentication unavailable");\n    }\n''',
    "same-round permanent critic failure",
)
s = replace_once(
    s,
    '''  it("reclaims skipped debate slots so surviving debaters can still retry", async () => {\n''',
    '''  it("reclaims same-round debate dropouts before retry gating", async () => {\n''',
    "test name",
)
s = replace_once(
    s,
    '''    expect(provider.roundOneGrokAttempts).toBe(2);\n    expect(result.steps.filter(step => step.kind === "critique")).toHaveLength(4);\n''',
    '''    expect(provider.roundOneGrokAttempts).toBe(2);\n    expect(result.steps.filter(step => step.kind === "answer")).toHaveLength(3);\n    expect(result.steps.filter(step => step.kind === "critique")).toHaveLength(4);\n    expect(result.degraded).toBe(true);\n''',
    "same-round assertions",
)
p.write_text(s)
