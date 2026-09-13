from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing target: {label}")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, new: str, label: str) -> str:
    i = text.find(start)
    if i < 0:
        raise SystemExit(f"missing start: {label}")
    j = text.find(end, i)
    if j < 0:
        raise SystemExit(f"missing end: {label}")
    return text[:i] + new + text[j:]


# Server: reserve baseline calls so a retry cannot consume a required downstream call.
p = Path("apps/server/src/orchestrator.ts")
s = p.read_text()
s = replace_once(
    s,
    '  usage: RunUsage;\n  stepUsage: Map<string, { inputTokens: number; outputTokens: number }>;\n};',
    '  usage: RunUsage;\n  stepUsage: Map<string, { inputTokens: number; outputTokens: number }>;\n  plannedCallsRemaining: number;\n};',
    "RunContext plannedCallsRemaining",
)

execute = '''  private async executeStep(spec: StepSpec, context: RunContext) {
    this.throwIfCancelled(context);
    let attempt = 0;
    let announced = false;

    while (true) {
      this.throwIfCancelled(context);
      const maxCalls = context.budget?.maxCalls;
      if (maxCalls !== undefined && context.usage.callsStarted >= maxCalls) {
        if (!announced) {
          context.emit?.({
            type: "step_started",
            runId: context.runId,
            stepId: spec.id,
            kind: spec.kind,
            model: spec.model,
            dependsOn: spec.dependsOn,
          });
        }
        const failure: StepFailure = {
          stepId: spec.id,
          kind: spec.kind,
          model: spec.model,
          message: `Run call budget exhausted at ${maxCalls} model calls.`,
          retryable: false,
          attempts: attempt,
        };
        context.emit?.({ type: "step_failed", runId: context.runId, failure });
        throw new StepExecutionError(failure);
      }

      if (attempt === 0) {
        context.plannedCallsRemaining = Math.max(0, context.plannedCallsRemaining - 1);
      }
      context.usage.callsStarted += 1;
      this.emitUsage(context);
      attempt += 1;

      if (!announced) {
        announced = true;
        context.emit?.({
          type: "step_started",
          runId: context.runId,
          stepId: spec.id,
          kind: spec.kind,
          model: spec.model,
          dependsOn: spec.dependsOn,
        });
      }

      let emittedText = false;
      try {
        const response = await this.adapterFor(spec.model).generate({
          model: spec.model.model,
          messages: [...(spec.history ?? []), { role: "user", content: spec.prompt }],
          signal: context.signal,
        }, event => {
          if (event.type === "text_delta" && event.delta) emittedText = true;
          this.mapProviderEvent(context, spec.id, event);
        });

        this.throwIfCancelled(context);
        context.usage.callsCompleted += 1;
        this.emitUsage(context);
        if (!emittedText && response.content) {
          context.emit?.({ type: "text_delta", runId: context.runId, stepId: spec.id, delta: response.content });
        }

        const step: OrchestrationStep = {
          id: spec.id,
          kind: spec.kind,
          model: spec.model,
          content: response.content,
          dependsOn: spec.dependsOn,
        };
        context.emit?.({ type: "step_completed", runId: context.runId, step });
        return step;
      } catch (error) {
        if (context.signal?.aborted) throw cancelledError();
        const retryable = isRetryableStepError(error);
        const hasRetryHeadroom = maxCalls === undefined
          || maxCalls - context.usage.callsStarted > context.plannedCallsRemaining;
        if (retryable && attempt < 2 && hasRetryHeadroom) {
          context.stepUsage.delete(spec.id);
          context.emit?.({
            type: "step_retrying",
            runId: context.runId,
            stepId: spec.id,
            attempt: attempt + 1,
            message: errorMessage(error),
          });
          continue;
        }
        if (isRateLimitError(error)) {
          context.emit?.({
            type: "rate_limit",
            runId: context.runId,
            notice: {
              provider: spec.model.provider,
              model: spec.model.model,
              stepId: spec.id,
              message: errorMessage(error),
              at: new Date().toISOString(),
            },
          });
        }
        const failure: StepFailure = {
          stepId: spec.id,
          kind: spec.kind,
          model: spec.model,
          message: errorMessage(error),
          retryable,
          attempts: attempt,
        };
        context.emit?.({ type: "step_failed", runId: context.runId, failure });
        throw new StepExecutionError(failure);
      }
    }
  }

'''
s = replace_between(
    s,
    '  private async executeStep(spec: StepSpec, context: RunContext) {',
    '  private failureFrom(error: unknown) {',
    execute,
    "executeStep",
)
s = replace_once(
    s,
    '      usage: emptyRunUsage(),\n      stepUsage: new Map(),\n    };',
    '      usage: emptyRunUsage(),\n      stepUsage: new Map(),\n      plannedCallsRemaining: 0,\n    };',
    "context initialization",
)
s = replace_once(
    s,
    '      this.validateRequest(request);\n      this.throwIfCancelled(context);',
    '      this.validateRequest(request);\n      context.plannedCallsRemaining = this.plannedCalls(request);\n      this.throwIfCancelled(context);',
    "planned call initialization",
)

consensus = '''      if (request.mode === "consensus") {
        const synthesisId = makeStepId("synthesis", 0);
        let synthesis: OrchestrationStep;
        try {
          synthesis = await this.executeStep({
            id: synthesisId,
            kind: "synthesis",
            model: synthesizer,
            prompt: `Build a candidate consensus from these independent answers. Include only claims supported by multiple positions or strongly justified by one position. Explicitly retain important dissent rather than forcing agreement.\n\nQuestion:\n${request.prompt}\n\nAnswers:\n${answersTranscript}`,
            history: request.history,
            dependsOn: independentIds,
          }, context);
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(this.buildResult(
            request.mode,
            independent,
            this.fallbackFinal("consensus synthesis", independent),
            [...failures, failure],
          ));
        }

        const verifier = independent.find(step => !sameModel(step.model, synthesizer))?.model
          ?? independent[0].model;
        try {
          const review = await this.executeStep({
            id: makeStepId("review", 0),
            kind: "review",
            model: verifier,
            prompt: `Audit the proposed consensus against the original independent answers. Remove false consensus, restore meaningful dissent, correct unsupported claims, and then output the corrected final answer.\n\nQuestion:\n${request.prompt}\n\nIndependent answers:\n${answersTranscript}\n\nProposed consensus:\n${synthesis.content}`,
            history: request.history,
            dependsOn: [...independentIds, synthesisId],
          }, context);
          return complete(this.buildResult(
            request.mode,
            [...independent, synthesis, review],
            review.content,
            failures,
          ));
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(this.buildResult(
            request.mode,
            [...independent, synthesis],
            synthesis.content,
            [...failures, failure],
          ));
        }
      }

'''
s = replace_between(
    s,
    '      if (request.mode === "consensus") {',
    '      if (request.mode === "debate") {',
    consensus,
    "consensus block",
)

debate = '''      if (request.mode === "debate") {
        const maxRounds = this.debateRounds(request);
        const debateSteps: OrchestrationStep[] = [...independent];
        let debateTranscript = answersTranscript;
        let previousIds = independentIds;
        let activeDebaters = independent.map(step => step.model);

        for (let round = 0; round < maxRounds && activeDebaters.length > 0; round += 1) {
          this.throwIfCancelled(context);
          const settled = await this.settleSteps(activeDebaters.map((model, index) => ({
            id: makeStepId(`critique-r${round + 1}`, index),
            kind: "critique" as const,
            model,
            prompt: `You are in debate round ${round + 1}. Identify the strongest disagreement or weakness in the other positions and state what should change.\n\nQuestion:\n${request.prompt}\n\nCurrent positions:\n${debateTranscript}`,
            history: request.history,
            dependsOn: previousIds,
          })), context, false);
          failures.push(...settled.failures);
          if (settled.steps.length === 0) break;

          debateSteps.push(...settled.steps);
          activeDebaters = settled.steps.map(step => step.model);
          previousIds = settled.steps.map(step => step.id);
          debateTranscript += "\n\n" + settled.steps
            .map(step => `${step.model.label} critique:\n${step.content}`)
            .join("\n\n");
        }

        try {
          const synthesis = await this.executeStep({
            id: makeStepId("synthesis", 0),
            kind: "synthesis",
            model: synthesizer,
            prompt: `Judge the debate. Produce the best-supported answer, explicitly noting unresolved disagreements and uncertainty.\n\nQuestion:\n${request.prompt}\n\nDebate:\n${debateTranscript}`,
            history: request.history,
            dependsOn: debateSteps.map(step => step.id),
          }, context);
          return complete(this.buildResult(
            request.mode,
            [...debateSteps, synthesis],
            synthesis.content,
            failures,
          ));
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(this.buildResult(
            request.mode,
            debateSteps,
            this.fallbackFinal("debate judgment", debateSteps),
            [...failures, failure],
          ));
        }
      }

'''
s = replace_between(
    s,
    '      if (request.mode === "debate") {',
    '      throw new Error(`Unsupported orchestration mode: ${request.mode}`);',
    debate,
    "debate block",
)
p.write_text(s)

# Tests: track model calls and cover retry reservation and survivor behavior.
p = Path("apps/server/src/orchestrator.test.ts")
s = p.read_text()
s = replace_once(
    s,
    '''class PartialFailureProvider extends MockProvider {
  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {
    if (request.model === "mock-claude" || request.model === "mock-finalizer") throw new Error("provider authentication unavailable");
    return super.generate(request);
  }
}
''',
    '''class PartialFailureProvider extends MockProvider {
  calls: string[] = [];

  override async generate(request: ProviderRequest, emit?: ProviderEventSink) {
    this.calls.push(request.model);
    if (request.model === "mock-claude" || request.model === "mock-finalizer") throw new Error("provider authentication unavailable");
    return super.generate(request);
  }
}

class AllAnswersFailProvider extends MockProvider {
  calls: string[] = [];

  override async generate(request: ProviderRequest) {
    this.calls.push(request.model);
    if (request.model !== "mock-finalizer") throw new Error("provider authentication unavailable");
    return super.generate(request);
  }
}
''',
    "test providers",
)
anchor = '  it("keeps successful panel contributions when one provider fails permanently", async () => {'
tests = '''  it("reserves the required finalizer call instead of spending it on a retry", async () => {
    const flaky = new FlakyProvider();
    const instance = new Orchestrator(new Map([[flaky.id, flaky]]));
    const result = await instance.run({
      mode: "panel",
      prompt: "Protect the finalizer",
      participants,
      budget: { maxCalls: 4, maxRounds: 1 },
    });

    expect(flaky.attempts.get("mock-claude")).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.steps.at(-1)?.kind).toBe("synthesis");
  });

  it("chooses a consensus verifier only from successful candidate models", async () => {
    const partial = new PartialFailureProvider();
    const instance = new Orchestrator(new Map([[partial.id, partial]]));
    const result = await instance.run({
      mode: "consensus",
      prompt: "Use a surviving verifier",
      participants,
      budget: { maxCalls: 5, maxRounds: 1 },
    });

    expect(result.degraded).toBe(true);
    expect(partial.calls.filter(model => model === "mock-claude")).toHaveLength(1);
    expect(result.steps.at(-1)?.kind).toBe("review");
    expect(result.steps.at(-1)?.model.model).toBe("mock-grok");
  });

  it("narrows debate rounds to providers that survived the previous stage", async () => {
    const partial = new PartialFailureProvider();
    const instance = new Orchestrator(new Map([[partial.id, partial]]));
    const result = await instance.run({
      mode: "debate",
      prompt: "Drop failed debaters",
      participants,
      budget: { maxCalls: 10, maxRounds: 2 },
    });

    expect(result.degraded).toBe(true);
    expect(partial.calls.filter(model => model === "mock-claude")).toHaveLength(1);
    expect(result.steps.filter(step => step.kind === "critique")).toHaveLength(4);
    expect(result.steps.at(-1)?.kind).toBe("synthesis");
  });

  it("does not invoke a finalizer when every independent answer fails", async () => {
    const failing = new AllAnswersFailProvider();
    const instance = new Orchestrator(new Map([[failing.id, failing]]));
    const finalizer: ModelRef = { provider: "mock", model: "mock-finalizer", label: "External Judge" };

    await expect(instance.run({
      mode: "judge",
      prompt: "No survivors",
      participants: [participants[0], participants[2]],
      synthesizer: finalizer,
      budget: { maxCalls: 3, maxRounds: 1 },
    })).rejects.toThrow(/all parallel model steps failed/i);
    expect(failing.calls).not.toContain("mock-finalizer");
  });

'''
if anchor not in s:
    raise SystemExit("missing test anchor")
s = s.replace(anchor, tests + anchor, 1)
p.write_text(s)

# Web: reset partial text on retry, show attempts, and pass full model catalog to summary.
p = Path("apps/web/src/main.tsx")
s = p.read_text()
retry_anchor = '''    if (streamEvent.type === "text_delta") {
      setLiveSteps(current => current.map(step => step.id === streamEvent.stepId
        ? { ...step, content: step.content + streamEvent.delta }
        : step));
      return;
    }
'''
retry_block = '''    if (streamEvent.type === "step_retrying") {
      setCompletedStepIds(current => current.filter(id => id !== streamEvent.stepId));
      setLiveSteps(current => current.map(step => step.id === streamEvent.stepId
        ? { ...step, content: "" }
        : step));
      return;
    }

''' + retry_anchor
s = replace_once(s, retry_anchor, retry_block, "step_retrying UI")
s = replace_once(
    s,
    '                          <span>{step.status}</span>\n                          <span>{elapsedLabel(step.durationMs)}</span>',
    '                          <span>{step.status}</span>\n                          {step.attempts && step.attempts > 1 && <span>{step.attempts} attempts</span>}\n                          <span>{elapsedLabel(step.durationMs)}</span>',
    "inspector attempts",
)
s = replace_once(
    s,
    '                        {step.error && <small className="inspection-step-error">{step.error}</small>}\n              {step.dependsOn.length > 0 && <small>after → {step.dependsOn.join(" · ")}</small>}',
    '                        {step.error && <small className="inspection-step-error">{step.error}</small>}\n                        {step.dependsOn.length > 0 && <small>after → {step.dependsOn.join(" · ")}</small>}',
    "inspector indentation",
)
s = replace_once(
    s,
    '            participants={participants}\n            synthesizer={effectiveSynthesizer}',
    '            participants={participants}\n            models={models}\n            synthesizer={effectiveSynthesizer}',
    "summary all models prop",
)
p.write_text(s)

# Web helper: prefer independent real/subscription models before mock placeholders.
p = Path("apps/web/src/reasoning-surface.tsx")
s = p.read_text()
s = replace_once(
    s,
    '  const participantKeys = new Set(participants.map(modelKey));\n  const independent = allModels.find(model => !participantKeys.has(modelKey(model)));\n  if (independent) return independent;',
    '  const participantKeys = new Set(participants.map(modelKey));\n  const independent = allModels.find(model => model.source !== "mock" && !participantKeys.has(modelKey(model)))\n    ?? allModels.find(model => !participantKeys.has(modelKey(model)));\n  if (independent) return independent;',
    "prefer subscription finalizer",
)
s = replace_once(
    s,
    '  participants,\n  synthesizer,',
    '  participants,\n  models,\n  synthesizer,',
    "summary destructure models",
)
s = replace_once(
    s,
    '  participants: ModelRef[];\n  synthesizer?: ModelRef;',
    '  participants: ModelRef[];\n  models: ModelRef[];\n  synthesizer?: ModelRef;',
    "summary models type",
)
s = replace_once(
    s,
    '  const synth = synthesizer ?? defaultFinalizer(mode, participants);',
    '  const synth = synthesizer ?? defaultFinalizer(mode, participants, models);',
    "summary finalizer catalog",
)
p.write_text(s)
