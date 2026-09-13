import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ModelRef,
  OrchestrationEventSink,
  OrchestrationRequest,
  OrchestrationResult,
  OrchestrationStep,
  OrchestrationStepKind,
  ProviderAdapter,
  ProviderStreamEvent,
  RunBudget,
  RunUsage,
  StepFailure,
  WorkflowGraph,
  WorkflowNode,
} from "@conclave/core";
import { emptyRunUsage, makeStepId } from "@conclave/core";

type RunOptions = {
  runId?: string;
  emit?: OrchestrationEventSink;
  signal?: AbortSignal;
};

type StepSpec = {
  id: string;
  kind: OrchestrationStepKind;
  model: ModelRef;
  prompt: string;
  history?: ChatMessage[];
  dependsOn?: string[];
};

type RunContext = {
  runId: string;
  emit?: OrchestrationEventSink;
  signal?: AbortSignal;
  budget?: RunBudget;
  usage: RunUsage;
  stepUsage: Map<string, { inputTokens: number; outputTokens: number }>;
  plannedCallsRemaining: number;
};

const researchAngles = [
  "Evidence auditor: separate established facts, assumptions, and uncertain claims. Identify what evidence would change the answer.",
  "Alternative-hypothesis analyst: develop the strongest competing explanations or options and compare them fairly.",
  "Implementation analyst: focus on feasibility, constraints, second-order effects, and likely failure modes.",
  "Skeptic: stress-test the framing, surface missing information, and challenge confident claims that are weakly supported.",
];

const workflowKinds = new Set<OrchestrationStepKind>([
  "answer",
  "critique",
  "revision",
  "synthesis",
  "judgment",
  "route",
  "research",
  "plan",
  "execution",
  "review",
]);

function sameModel(a: ModelRef, b: ModelRef) {
  return a.provider === b.provider && a.model === b.model;
}

function modelKey(model: ModelRef) {
  return `${model.provider}:${model.model}`;
}

function transcript(steps: OrchestrationStep[], suffix = "") {
  return steps
    .map((step) => `${step.model.label}${suffix}:\n${step.content}`)
    .join("\n\n");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown orchestration error";
}

function isRateLimitError(error: unknown) {
  return /rate.?limit|too many requests|quota|usage limit|capacity limit|exhausted/i.test(
    errorMessage(error),
  );
}

function cancelledError() {
  const error = new Error("Run cancelled by user");
  error.name = "AbortError";
  return error;
}

function isRetryableStepError(error: unknown) {
  const message = errorMessage(error);
  if (
    /abort|cancel|rate.?limit|quota|usage limit|auth|login|billing|api.?key|permission|unsupported|invalid request/i.test(
      message,
    )
  )
    return false;
  return /timeout|timed out|temporar|connection|ECONN|EPIPE|socket|closed|EOF|unavailable|busy|overloaded|try again|exited|terminated|spawn/i.test(
    message,
  );
}

class StepExecutionError extends Error {
  constructor(readonly failure: StepFailure) {
    super(failure.message);
    this.name = "StepExecutionError";
  }
}

export class Orchestrator {
  constructor(private readonly providers: Map<string, ProviderAdapter>) {}

  private adapterFor(model: ModelRef) {
    const adapter = this.providers.get(model.provider);
    if (!adapter)
      throw new Error(`No provider adapter registered for ${model.provider}`);
    return adapter;
  }

  private requireParticipants(request: OrchestrationRequest, minimum: number) {
    if (request.participants.length < minimum) {
      throw new Error(
        `${request.mode} mode requires at least ${minimum} participants`,
      );
    }
  }

  private debateRounds(request: OrchestrationRequest) {
    const requested = request.budget?.maxRounds ?? request.maxRounds ?? 1;
    return Math.max(1, Math.min(requested, 3));
  }

  private validateWorkflow(request: OrchestrationRequest): WorkflowGraph {
    const graph = request.workflow;
    if (!graph || typeof graph !== "object")
      throw new Error("Custom mode requires a workflow graph");
    if (typeof graph.name !== "string" || !graph.name.trim())
      throw new Error("Workflow name is required");
    if (typeof graph.outputNodeId !== "string" || !graph.outputNodeId.trim()) {
      throw new Error("Workflow outputNodeId is required");
    }
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      throw new Error("Workflow must contain at least one node");
    }
    if (graph.nodes.length > 64)
      throw new Error("Workflow cannot contain more than 64 nodes");

    const byId = new Map<string, WorkflowNode>();
    for (const candidate of graph.nodes) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        throw new Error("Every workflow node must be an object");
      }
      const node = candidate as WorkflowNode;
      if (
        typeof node.id !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(node.id)
      ) {
        throw new Error(
          `Workflow node ID '${String(node.id)}' must start with a letter and contain only letters, numbers, _ or -`,
        );
      }
      if (byId.has(node.id))
        throw new Error(`Workflow node ID '${node.id}' is duplicated`);
      if (
        typeof node.kind !== "string" ||
        !workflowKinds.has(node.kind as OrchestrationStepKind)
      ) {
        throw new Error(
          `Workflow node '${node.id}' has unsupported kind '${String(node.kind)}'`,
        );
      }
      if (
        typeof node.promptTemplate !== "string" ||
        !node.promptTemplate.trim()
      ) {
        throw new Error(
          `Workflow node '${node.id}' requires a string prompt template`,
        );
      }
      if (node.promptTemplate.length > 20_000)
        throw new Error(
          `Workflow node '${node.id}' prompt template is too long`,
        );
      if (
        !node.model ||
        typeof node.model !== "object" ||
        Array.isArray(node.model)
      ) {
        throw new Error(
          `Workflow node '${node.id}' has an unsupported model selector`,
        );
      }

      if (node.model.type === "participant") {
        if (
          !Number.isInteger(node.model.index) ||
          node.model.index < 0 ||
          node.model.index >= request.participants.length
        ) {
          throw new Error(
            `Workflow node '${node.id}' requires participant ${node.model.index + 1}, but only ${request.participants.length} participant${request.participants.length === 1 ? " is" : "s are"} selected`,
          );
        }
      } else if (node.model.type !== "synthesizer") {
        throw new Error(
          `Workflow node '${node.id}' has an unsupported model selector`,
        );
      }
      byId.set(node.id, node);
    }

    if (!byId.has(graph.outputNodeId)) {
      throw new Error(
        `Workflow output node '${graph.outputNodeId}' does not exist`,
      );
    }

    for (const node of graph.nodes) {
      const dependencies = node.dependsOn ?? [];
      if (!Array.isArray(dependencies))
        throw new Error(
          `Workflow node '${node.id}' dependsOn must be an array`,
        );
      if (dependencies.some((dependency) => typeof dependency !== "string")) {
        throw new Error(
          `Workflow node '${node.id}' dependencies must be node IDs`,
        );
      }
      if (new Set(dependencies).size !== dependencies.length) {
        throw new Error(
          `Workflow node '${node.id}' contains duplicate dependencies`,
        );
      }
      for (const dependency of dependencies) {
        if (dependency === node.id)
          throw new Error(`Workflow node '${node.id}' cannot depend on itself`);
        if (!byId.has(dependency))
          throw new Error(
            `Workflow node '${node.id}' depends on missing node '${dependency}'`,
          );
      }
      const explicitRefs = [
        ...node.promptTemplate.matchAll(
          /\{\{dep\.([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/g,
        ),
      ].map((match) => match[1]);
      for (const reference of explicitRefs) {
        if (!dependencies.includes(reference)) {
          throw new Error(
            `Workflow node '${node.id}' references '${reference}' without declaring it in dependsOn`,
          );
        }
      }
    }

    const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(
      graph.nodes.map((node) => [node.id, [] as string[]]),
    );
    for (const node of graph.nodes) {
      for (const dependency of node.dependsOn ?? []) {
        indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
        outgoing.get(dependency)?.push(node.id);
      }
    }
    const ready = [...indegree.entries()]
      .filter(([, degree]) => degree === 0)
      .map(([id]) => id);
    let visited = 0;
    while (ready.length > 0) {
      const id = ready.shift()!;
      visited += 1;
      for (const next of outgoing.get(id) ?? []) {
        const degree = (indegree.get(next) ?? 1) - 1;
        indegree.set(next, degree);
        if (degree === 0) ready.push(next);
      }
    }
    if (visited !== graph.nodes.length)
      throw new Error("Workflow graph contains a dependency cycle");

    const outputCone = new Set<string>();
    const includeAncestors = (nodeId: string) => {
      if (outputCone.has(nodeId)) return;
      outputCone.add(nodeId);
      const node = byId.get(nodeId);
      for (const dependency of node?.dependsOn ?? [])
        includeAncestors(dependency);
    };
    includeAncestors(graph.outputNodeId);
    const unused = graph.nodes
      .filter((node) => !outputCone.has(node.id))
      .map((node) => node.id);
    if (unused.length > 0) {
      throw new Error(
        `Workflow contains node${unused.length === 1 ? "" : "s"} not connected to output '${graph.outputNodeId}': ${unused.join(", ")}`,
      );
    }

    return graph;
  }

  private validateShape(request: OrchestrationRequest) {
    if (request.participants.length === 0)
      throw new Error("At least one participant is required");
    if (request.mode === "single" && request.participants.length !== 1) {
      throw new Error("Single mode requires exactly one participant");
    }
    if (
      ["router", "research-council", "judge", "consensus"].includes(
        request.mode,
      )
    ) {
      this.requireParticipants(request, 2);
    }
    if (request.mode === "custom") this.validateWorkflow(request);
  }

  private plannedCalls(request: OrchestrationRequest) {
    const count = request.participants.length;
    switch (request.mode) {
      case "single":
        return 1;
      case "compare":
        return count;
      case "panel":
        return count + 1;
      case "debate":
        return count + count * this.debateRounds(request) + 1;
      case "critic-revise":
        return 3;
      case "consensus":
        return count + 2;
      case "judge":
        return count + 1;
      case "red-team":
        return 1 + Math.max(count - 1, 1) + 1;
      case "router":
        return 2;
      case "research-council":
        return count + 1;
      case "planner-executor":
        return 1 + Math.max(count - 1, 1) + 1;
      case "custom":
        return this.validateWorkflow(request).nodes.length;
    }
  }

  private enforceBudget(request: OrchestrationRequest) {
    const maxCalls = request.budget?.maxCalls;
    if (maxCalls !== undefined) {
      const planned = this.plannedCalls(request);
      if (planned > maxCalls) {
        throw new Error(
          `Run budget allows ${maxCalls} model call${maxCalls === 1 ? "" : "s"}, but ${request.mode} requires ${planned} with the current participants and rounds.`,
        );
      }
    }
  }

  validateRequest(request: OrchestrationRequest) {
    this.validateShape(request);
    this.enforceBudget(request);
  }

  private throwIfCancelled(context: RunContext) {
    if (context.signal?.aborted) throw cancelledError();
  }

  private emitUsage(context: RunContext) {
    context.emit?.({
      type: "run_usage",
      runId: context.runId,
      usage: { ...context.usage },
      budget: context.budget,
    });
  }

  private mapProviderEvent(
    context: RunContext,
    stepId: string,
    event: ProviderStreamEvent,
  ) {
    const { runId, emit } = context;
    if (event.type === "usage") {
      const previous = context.stepUsage.get(stepId) ?? {
        inputTokens: 0,
        outputTokens: 0,
      };
      const next = {
        inputTokens: event.inputTokens ?? previous.inputTokens,
        outputTokens: event.outputTokens ?? previous.outputTokens,
      };
      context.usage.inputTokens += Math.max(
        0,
        next.inputTokens - previous.inputTokens,
      );
      context.usage.outputTokens += Math.max(
        0,
        next.outputTokens - previous.outputTokens,
      );
      context.usage.tokenReports += 1;
      context.stepUsage.set(stepId, next);
      emit?.({
        type: "usage",
        runId,
        stepId,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
      this.emitUsage(context);
      return;
    }

    if (!emit) return;
    switch (event.type) {
      case "text_delta":
        emit({ type: "text_delta", runId, stepId, delta: event.delta });
        break;
      case "status":
        emit({ type: "status", runId, stepId, message: event.message });
        break;
      case "tool_call":
        emit({
          type: "tool_call",
          runId,
          stepId,
          id: event.id,
          name: event.name,
          input: event.input,
        });
        break;
      case "tool_result":
        emit({
          type: "tool_result",
          runId,
          stepId,
          id: event.id,
          output: event.output,
          isError: event.isError,
        });
        break;
      case "citation":
        emit({
          type: "citation",
          runId,
          stepId,
          url: event.url,
          title: event.title,
        });
        break;
    }
  }

  private async executeStep(spec: StepSpec, context: RunContext) {
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
        context.plannedCallsRemaining = Math.max(
          0,
          context.plannedCallsRemaining - 1,
        );
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
        const response = await this.adapterFor(spec.model).generate(
          {
            model: spec.model.model,
            messages: [
              ...(spec.history ?? []),
              { role: "user", content: spec.prompt },
            ],
            signal: context.signal,
          },
          (event) => {
            if (event.type === "text_delta" && event.delta) emittedText = true;
            this.mapProviderEvent(context, spec.id, event);
          },
        );

        this.throwIfCancelled(context);
        context.usage.callsCompleted += 1;
        this.emitUsage(context);
        if (!emittedText && response.content) {
          context.emit?.({
            type: "text_delta",
            runId: context.runId,
            stepId: spec.id,
            delta: response.content,
          });
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
        const hasRetryHeadroom =
          maxCalls === undefined ||
          maxCalls - context.usage.callsStarted > context.plannedCallsRemaining;
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

  private failureFrom(error: unknown) {
    return error instanceof StepExecutionError ? error.failure : undefined;
  }

  private async settleSteps(
    specs: StepSpec[],
    context: RunContext,
    requireSuccess = true,
  ) {
    const settled = await Promise.allSettled(
      specs.map((spec) => this.executeStep(spec, context)),
    );
    this.throwIfCancelled(context);
    const steps: OrchestrationStep[] = [];
    const failures: StepFailure[] = [];
    for (const item of settled) {
      if (item.status === "fulfilled") steps.push(item.value);
      else {
        const failure = this.failureFrom(item.reason);
        if (failure) failures.push(failure);
        else throw item.reason;
      }
    }
    if (requireSuccess && steps.length === 0) {
      const detail = failures
        .map((failure) => `${failure.model.label}: ${failure.message}`)
        .join("; ");
      throw new Error(
        `All parallel model steps failed${detail ? `: ${detail}` : "."}`,
      );
    }
    return { steps, failures };
  }

  private buildResult(
    mode: OrchestrationRequest["mode"],
    steps: OrchestrationStep[],
    final: string,
    failures: StepFailure[] = [],
  ): OrchestrationResult {
    return failures.length > 0
      ? { mode, steps, final, degraded: true, failures }
      : { mode, steps, final };
  }

  private fallbackFinal(label: string, steps: OrchestrationStep[]) {
    return `Conclave could not complete ${label}. The response below preserves the surviving model work without pretending the missing finalization succeeded.

${transcript(steps)}`;
  }

  private async independentAnswers(
    request: OrchestrationRequest,
    context: RunContext,
  ) {
    return this.settleSteps(
      request.participants.map((model, index) => ({
        id: makeStepId("answer", index),
        kind: "answer" as const,
        model,
        prompt: request.prompt,
        history: request.history,
      })),
      context,
    );
  }

  private routedModel(
    route: string,
    participants: ModelRef[],
    router: ModelRef,
  ) {
    const routeLine = route
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^ROUTE\s*:/i.test(line));
    const requested = routeLine
      ?.replace(/^ROUTE\s*:/i, "")
      .trim()
      .replace(/^`|`$/g, "")
      .toLowerCase();

    if (requested) {
      const exact = participants.find(
        (model) =>
          modelKey(model).toLowerCase() === requested ||
          model.model.toLowerCase() === requested ||
          model.label.toLowerCase() === requested,
      );
      if (exact) return exact;
    }

    return participants.find((model) => !sameModel(model, router)) ?? router;
  }

  private workflowModel(node: WorkflowNode, request: OrchestrationRequest) {
    if (node.model.type === "synthesizer")
      return request.synthesizer ?? request.participants[0];
    return request.participants[node.model.index];
  }

  private workflowPrompt(
    node: WorkflowNode,
    request: OrchestrationRequest,
    completed: Map<string, OrchestrationStep>,
  ) {
    const dependencies = (node.dependsOn ?? [])
      .map((id) => completed.get(id))
      .filter((step): step is OrchestrationStep => Boolean(step));
    const dependencyTranscript = dependencies
      .map((step) => `[${step.id}] ${step.model.label}:\n${step.content}`)
      .join("\n\n");

    // Interpolate the original template in one pass. Values inserted from the
    // user or another model are never re-scanned as template syntax.
    return node.promptTemplate.replace(
      /\{\{(prompt|dependencies|dep\.([A-Za-z][A-Za-z0-9_-]{0,63}))\}\}/g,
      (_placeholder: string, token: string, dependencyId?: string) => {
        if (token === "prompt") return request.prompt;
        if (token === "dependencies") return dependencyTranscript;
        return dependencyId ? (completed.get(dependencyId)?.content ?? "") : "";
      },
    );
  }

  private async runCustom(request: OrchestrationRequest, context: RunContext) {
    const graph = this.validateWorkflow(request);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const completed = new Map<string, OrchestrationStep>();
    const tasks = new Map<string, Promise<OrchestrationStep>>();
    const workflowController = new AbortController();
    const onOuterAbort = () => workflowController.abort();
    if (context.signal?.aborted) workflowController.abort();
    else
      context.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const workflowContext: RunContext = {
      ...context,
      signal: workflowController.signal,
    };

    const runNode = (node: WorkflowNode): Promise<OrchestrationStep> => {
      const existing = tasks.get(node.id);
      if (existing) return existing;

      const task = Promise.all(
        (node.dependsOn ?? []).map((dependencyId) => {
          const dependency = byId.get(dependencyId);
          if (!dependency)
            throw new Error(
              `Workflow node '${node.id}' depends on missing node '${dependencyId}'`,
            );
          return runNode(dependency);
        }),
      ).then(async () => {
        this.throwIfCancelled(workflowContext);
        const step = await this.executeStep(
          {
            id: node.id,
            kind: node.kind,
            model: this.workflowModel(node, request),
            prompt: this.workflowPrompt(node, request, completed),
            history: request.history,
            dependsOn: node.dependsOn,
          },
          workflowContext,
        );
        completed.set(step.id, step);
        return step;
      });
      tasks.set(node.id, task);
      return task;
    };

    try {
      const all = graph.nodes.map((node) => runNode(node));
      const results = await Promise.all(all).catch(async (error) => {
        workflowController.abort();
        await Promise.allSettled(all);
        throw error;
      });
      const byResultId = new Map(results.map((step) => [step.id, step]));
      const ordered = graph.nodes.map((node) => byResultId.get(node.id)!);
      const output = byResultId.get(graph.outputNodeId);
      if (!output)
        throw new Error(
          `Workflow output node '${graph.outputNodeId}' did not complete`,
        );
      return {
        mode: request.mode,
        steps: ordered,
        final: output.content,
      } satisfies OrchestrationResult;
    } finally {
      context.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  async run(
    request: OrchestrationRequest,
    options: RunOptions = {},
  ): Promise<OrchestrationResult> {
    const runId = options.runId ?? randomUUID();
    const context: RunContext = {
      runId,
      emit: options.emit,
      signal: options.signal,
      budget: request.budget,
      usage: emptyRunUsage(),
      stepUsage: new Map(),
      plannedCallsRemaining: 0,
    };

    context.emit?.({ type: "run_started", runId, mode: request.mode });
    this.emitUsage(context);

    try {
      this.validateRequest(request);
      context.plannedCallsRemaining = this.plannedCalls(request);
      this.throwIfCancelled(context);

      const complete = (result: OrchestrationResult) => {
        context.emit?.({ type: "run_completed", runId, result });
        return result;
      };

      if (request.mode === "custom") {
        return complete(await this.runCustom(request, context));
      }

      if (request.mode === "single") {
        const model = request.participants[0];
        const step = await this.executeStep(
          {
            id: makeStepId("answer", 0),
            kind: "answer",
            model,
            prompt: request.prompt,
            history: request.history,
          },
          context,
        );
        return complete({
          mode: request.mode,
          steps: [step],
          final: step.content,
        });
      }

      if (request.mode === "critic-revise") {
        const author = request.participants[0];
        const critic = request.participants[1] ?? author;
        const failures: StepFailure[] = [];
        const draftId = makeStepId("answer", 0);
        const critiqueId = makeStepId("critique", 0);
        const draft = await this.executeStep(
          {
            id: draftId,
            kind: "answer",
            model: author,
            prompt: request.prompt,
            history: request.history,
          },
          context,
        );
        let critique: OrchestrationStep;
        try {
          critique = await this.executeStep(
            {
              id: critiqueId,
              kind: "critique",
              model: critic,
              prompt: `Critique this answer for factual gaps, weak reasoning, and missing alternatives.

Question:
${request.prompt}

Draft:
${draft.content}`,
              history: request.history,
              dependsOn: [draftId],
            },
            context,
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          failures.push(failure);
          return complete(
            this.buildResult(request.mode, [draft], draft.content, failures),
          );
        }
        try {
          const revision = await this.executeStep(
            {
              id: makeStepId("revision", 0),
              kind: "revision",
              model: author,
              prompt: `Revise your answer using the critique. Keep only improvements you can justify.

Question:
${request.prompt}

Draft:
${draft.content}

Critique:
${critique.content}`,
              history: request.history,
              dependsOn: [draftId, critiqueId],
            },
            context,
          );
          return complete(
            this.buildResult(
              request.mode,
              [draft, critique, revision],
              revision.content,
              failures,
            ),
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          failures.push(failure);
          return complete(
            this.buildResult(
              request.mode,
              [draft, critique],
              draft.content,
              failures,
            ),
          );
        }
      }

      if (request.mode === "red-team") {
        const author = request.participants[0];
        const draftId = makeStepId("answer", 0);
        const draft = await this.executeStep(
          {
            id: draftId,
            kind: "answer",
            model: author,
            prompt: request.prompt,
            history: request.history,
          },
          context,
        );
        const critics = request.participants.slice(1);
        const redTeam = critics.length > 0 ? critics : [author];
        const settled = await this.settleSteps(
          redTeam.map((model, index) => ({
            id: makeStepId("red-team", index),
            kind: "critique" as const,
            model,
            prompt: `Red-team the draft below. Look for false assumptions, counterexamples, safety or implementation failures, adversarial cases, and ways the conclusion could be wrong. Do not merely rewrite it.

Question:
${request.prompt}

Draft:
${draft.content}`,
            history: request.history,
            dependsOn: [draftId],
          })),
          context,
          false,
        );
        if (settled.steps.length === 0)
          return complete(
            this.buildResult(
              request.mode,
              [draft],
              draft.content,
              settled.failures,
            ),
          );
        try {
          const revision = await this.executeStep(
            {
              id: makeStepId("revision", 0),
              kind: "revision",
              model: author,
              prompt: `Produce a hardened final answer after the red-team review. Address valid attacks, reject invalid ones explicitly when necessary, and preserve uncertainty.

Question:
${request.prompt}

Draft:
${draft.content}

Red-team findings:
${transcript(settled.steps, " critique")}`,
              history: request.history,
              dependsOn: [draftId, ...settled.steps.map((step) => step.id)],
            },
            context,
          );
          return complete(
            this.buildResult(
              request.mode,
              [draft, ...settled.steps, revision],
              revision.content,
              settled.failures,
            ),
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(
            this.buildResult(
              request.mode,
              [draft, ...settled.steps],
              draft.content,
              [...settled.failures, failure],
            ),
          );
        }
      }

      if (request.mode === "router") {
        const router = request.participants[0];
        const routeId = makeStepId("route", 0);
        const choices = request.participants
          .map((model) => `- ${modelKey(model)} — ${model.label}`)
          .join("\n");
        const route = await this.executeStep(
          {
            id: routeId,
            kind: "route",
            model: router,
            prompt: `Route the question to exactly one of the available models. On the first line output exactly ROUTE: provider:model using one key from the list. Then briefly explain why that model is the best fit. Do not answer the question itself.\n\nQuestion:\n${request.prompt}\n\nAvailable models:\n${choices}`,
            history: request.history,
          },
          context,
        );
        const specialist = this.routedModel(
          route.content,
          request.participants,
          router,
        );
        const answer = await this.executeStep(
          {
            id: makeStepId("answer", 0),
            kind: "answer",
            model: specialist,
            prompt: `Answer the original question directly. You were selected by a routing step; the router's note is context, not authority.\n\nQuestion:\n${request.prompt}\n\nRouter note:\n${route.content}`,
            history: request.history,
            dependsOn: [routeId],
          },
          context,
        );
        return complete({
          mode: request.mode,
          steps: [route, answer],
          final: answer.content,
        });
      }

      if (request.mode === "planner-executor") {
        const planner = request.participants[0];
        const planId = makeStepId("plan", 0);
        const plan = await this.executeStep(
          {
            id: planId,
            kind: "plan",
            model: planner,
            prompt: `Create a concrete plan for solving the question or task. Break it into ordered work items, name assumptions and dependencies, and define what a good final answer must contain. Do not pretend to perform external actions.

Task:
${request.prompt}`,
            history: request.history,
          },
          context,
        );
        const availableExecutors = request.participants.slice(1);
        const executors =
          availableExecutors.length > 0 ? availableExecutors : [planner];
        const settled = await this.settleSteps(
          executors.map((model, index) => ({
            id: makeStepId("execution", index),
            kind: "execution" as const,
            model,
            prompt: `Act as executor ${index + 1}. Carry out the parts of the plan you can solve in text, produce concrete analysis/output, and flag any plan defect you discover. Do not claim external actions or research you did not perform.

Task:
${request.prompt}

Plan:
${plan.content}`,
            history: request.history,
            dependsOn: [planId],
          })),
          context,
          false,
        );
        const reviewer =
          request.synthesizer ?? request.participants.at(-1) ?? planner;
        try {
          const review = await this.executeStep(
            {
              id: makeStepId("review", 0),
              kind: "review",
              model: reviewer,
              prompt: `Review the plan and executor outputs. Resolve conflicts, correct mistakes, and return the best final answer to the original task. Do not narrate the workflow unless it helps the user.

Task:
${request.prompt}

Plan:
${plan.content}

Executor outputs:
${transcript(settled.steps, " execution")}`,
              history: request.history,
              dependsOn: [planId, ...settled.steps.map((step) => step.id)],
            },
            context,
          );
          return complete(
            this.buildResult(
              request.mode,
              [plan, ...settled.steps, review],
              review.content,
              settled.failures,
            ),
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          const survivors = settled.steps.length > 0 ? settled.steps : [plan];
          return complete(
            this.buildResult(
              request.mode,
              [plan, ...settled.steps],
              this.fallbackFinal("review", survivors),
              [...settled.failures, failure],
            ),
          );
        }
      }

      if (request.mode === "research-council") {
        const researchBriefs = request.participants.map((_, memberIndex) => {
          const assignedAngles = researchAngles.filter(
            (_, angleIndex) =>
              angleIndex % request.participants.length === memberIndex,
          );
          return assignedAngles.length > 0
            ? assignedAngles.join(" ")
            : "Independent analyst: approach the question from a distinct perspective not already covered by the other council members.";
        });
        const settled = await this.settleSteps(
          request.participants.map((model, index) => ({
            id: makeStepId("research", index),
            kind: "research" as const,
            model,
            prompt: `You are one member of a research council. ${researchBriefs[index]} Use only knowledge and context actually available to you; do not claim that you browsed, ran experiments, or consulted sources unless that happened in this run. Clearly mark uncertainty.

Question:
${request.prompt}`,
            history: request.history,
          })),
          context,
        );
        const synthesizer = request.synthesizer ?? request.participants[0];
        try {
          const synthesis = await this.executeStep(
            {
              id: makeStepId("synthesis", 0),
              kind: "synthesis",
              model: synthesizer,
              prompt: `Synthesize the council reports into a rigorous answer. Reconcile compatible findings, preserve material disagreements, distinguish evidence from inference, and state what remains unknown. Do not invent citations or imply external research occurred.

Question:
${request.prompt}

Council reports:
${transcript(settled.steps, " report")}`,
              history: request.history,
              dependsOn: settled.steps.map((step) => step.id),
            },
            context,
          );
          return complete(
            this.buildResult(
              request.mode,
              [...settled.steps, synthesis],
              synthesis.content,
              settled.failures,
            ),
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(
            this.buildResult(
              request.mode,
              settled.steps,
              this.fallbackFinal("council synthesis", settled.steps),
              [...settled.failures, failure],
            ),
          );
        }
      }

      const independentOutcome = await this.independentAnswers(
        request,
        context,
      );
      const independent = independentOutcome.steps;
      const failures: StepFailure[] = [...independentOutcome.failures];

      if (request.mode === "compare") {
        return complete(
          this.buildResult(
            request.mode,
            independent,
            independent.map((step) => step.content).join("\n\n---\n\n"),
            failures,
          ),
        );
      }

      const synthesizer = request.synthesizer ?? request.participants[0];
      const answersTranscript = transcript(independent);
      const independentIds = independent.map((step) => step.id);

      if (request.mode === "panel") {
        try {
          const synthesis = await this.executeStep(
            {
              id: makeStepId("synthesis", 0),
              kind: "synthesis",
              model: synthesizer,
              prompt: `Synthesize the independent answers below. Preserve useful disagreements and do not invent consensus.

Question:
${request.prompt}

Answers:
${answersTranscript}`,
              history: request.history,
              dependsOn: independentIds,
            },
            context,
          );
          return complete(
            this.buildResult(
              request.mode,
              [...independent, synthesis],
              synthesis.content,
              failures,
            ),
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(
            this.buildResult(
              request.mode,
              independent,
              this.fallbackFinal("panel synthesis", independent),
              [...failures, failure],
            ),
          );
        }
      }

      if (request.mode === "judge") {
        try {
          const judgment = await this.executeStep(
            {
              id: makeStepId("judgment", 0),
              kind: "judgment",
              model: synthesizer,
              prompt: `Act as a judge. Evaluate the candidate answers for correctness, reasoning quality, completeness, calibration, and usefulness. Select or combine only the best-supported material and return the final answer to the user. Mention a material unresolved disagreement if it changes the recommendation.

Question:
${request.prompt}

Candidates:
${answersTranscript}`,
              history: request.history,
              dependsOn: independentIds,
            },
            context,
          );
          return complete(
            this.buildResult(
              request.mode,
              [...independent, judgment],
              judgment.content,
              failures,
            ),
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(
            this.buildResult(
              request.mode,
              independent,
              this.fallbackFinal("judgment", independent),
              [...failures, failure],
            ),
          );
        }
      }

      if (request.mode === "consensus") {
        const synthesisId = makeStepId("synthesis", 0);
        let synthesis: OrchestrationStep;
        try {
          synthesis = await this.executeStep(
            {
              id: synthesisId,
              kind: "synthesis",
              model: synthesizer,
              prompt: `Build a candidate consensus from these independent answers. Include only claims supported by multiple positions or strongly justified by one position. Explicitly retain important dissent rather than forcing agreement.

Question:
${request.prompt}

Answers:
${answersTranscript}`,
              history: request.history,
              dependsOn: independentIds,
            },
            context,
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(
            this.buildResult(
              request.mode,
              independent,
              this.fallbackFinal("consensus synthesis", independent),
              [...failures, failure],
            ),
          );
        }

        const verifier =
          independent.find((step) => !sameModel(step.model, synthesizer))
            ?.model ?? independent[0].model;
        try {
          const review = await this.executeStep(
            {
              id: makeStepId("review", 0),
              kind: "review",
              model: verifier,
              prompt: `Audit the proposed consensus against the original independent answers. Remove false consensus, restore meaningful dissent, correct unsupported claims, and then output the corrected final answer.

Question:
${request.prompt}

Independent answers:
${answersTranscript}

Proposed consensus:
${synthesis.content}`,
              history: request.history,
              dependsOn: [...independentIds, synthesisId],
            },
            context,
          );
          return complete(
            this.buildResult(
              request.mode,
              [...independent, synthesis, review],
              review.content,
              failures,
            ),
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(
            this.buildResult(
              request.mode,
              [...independent, synthesis],
              synthesis.content,
              [...failures, failure],
            ),
          );
        }
      }

      if (request.mode === "debate") {
        const maxRounds = this.debateRounds(request);
        const debateSteps: OrchestrationStep[] = [...independent];
        let debateTranscript = answersTranscript;
        let previousIds = independentIds;
        let activeDebaters = independent.map((step) => step.model);
        const skippedInitialDebaters = request.participants.length - activeDebaters.length;
        if (skippedInitialDebaters > 0) {
          context.plannedCallsRemaining = Math.max(
            0,
            context.plannedCallsRemaining - skippedInitialDebaters * maxRounds,
          );
        }

        for (
          let round = 0;
          round < maxRounds && activeDebaters.length > 0;
          round += 1
        ) {
          this.throwIfCancelled(context);
          const roundDebaterCount = activeDebaters.length;
          const settled = await this.settleSteps(
            activeDebaters.map((model, index) => ({
              id: makeStepId(`critique-r${round + 1}`, index),
              kind: "critique" as const,
              model,
              prompt: `You are in debate round ${round + 1}. Identify the strongest disagreement or weakness in the other positions and state what should change.

Question:
${request.prompt}

Current positions:
${debateTranscript}`,
              history: request.history,
              dependsOn: previousIds,
            })),
            context,
            false,
          );
          failures.push(...settled.failures);
          const nextDebaters = settled.steps.map((step) => step.model);
          const droppedDebaters = roundDebaterCount - nextDebaters.length;
          const remainingRounds = maxRounds - round - 1;
          if (droppedDebaters > 0 && remainingRounds > 0) {
            context.plannedCallsRemaining = Math.max(
              0,
              context.plannedCallsRemaining - droppedDebaters * remainingRounds,
            );
          }
          activeDebaters = nextDebaters;
          if (settled.steps.length === 0) break;

          debateSteps.push(...settled.steps);
          previousIds = settled.steps.map((step) => step.id);
          debateTranscript +=
            "\n\n" +
            settled.steps
              .map(
                (step) => `${step.model.label} critique:
${step.content}`,
              )
              .join("\n\n");
        }

        try {
          const synthesis = await this.executeStep(
            {
              id: makeStepId("synthesis", 0),
              kind: "synthesis",
              model: synthesizer,
              prompt: `Judge the debate. Produce the best-supported answer, explicitly noting unresolved disagreements and uncertainty.

Question:
${request.prompt}

Debate:
${debateTranscript}`,
              history: request.history,
              dependsOn: debateSteps.map((step) => step.id),
            },
            context,
          );
          return complete(
            this.buildResult(
              request.mode,
              [...debateSteps, synthesis],
              synthesis.content,
              failures,
            ),
          );
        } catch (error) {
          const failure = this.failureFrom(error);
          if (!failure) throw error;
          return complete(
            this.buildResult(
              request.mode,
              debateSteps,
              this.fallbackFinal("debate judgment", debateSteps),
              [...failures, failure],
            ),
          );
        }
      }

      throw new Error(`Unsupported orchestration mode: ${request.mode}`);
    } catch (error) {
      if (context.signal?.aborted) {
        context.emit?.({
          type: "run_cancelled",
          runId,
          message: "Run cancelled by user",
        });
        throw cancelledError();
      }
      context.emit?.({ type: "error", runId, message: errorMessage(error) });
      throw error;
    }
  }
}
