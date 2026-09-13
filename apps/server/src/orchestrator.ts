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
} from "@conclave/core";
import { makeStepId } from "@conclave/core";

type RunOptions = {
  runId?: string;
  emit?: OrchestrationEventSink;
};

type StepSpec = {
  id: string;
  kind: OrchestrationStepKind;
  model: ModelRef;
  prompt: string;
  history?: ChatMessage[];
};

const researchAngles = [
  "Evidence auditor: separate established facts, assumptions, and uncertain claims. Identify what evidence would change the answer.",
  "Alternative-hypothesis analyst: develop the strongest competing explanations or options and compare them fairly.",
  "Implementation analyst: focus on feasibility, constraints, second-order effects, and likely failure modes.",
  "Skeptic: stress-test the framing, surface missing information, and challenge confident claims that are weakly supported.",
];

function sameModel(a: ModelRef, b: ModelRef) {
  return a.provider === b.provider && a.model === b.model;
}

function modelKey(model: ModelRef) {
  return `${model.provider}:${model.model}`;
}

function transcript(steps: OrchestrationStep[], suffix = "") {
  return steps
    .map(step => `${step.model.label}${suffix}:\n${step.content}`)
    .join("\n\n");
}

export class Orchestrator {
  constructor(private readonly providers: Map<string, ProviderAdapter>) {}

  private adapterFor(model: ModelRef) {
    const adapter = this.providers.get(model.provider);
    if (!adapter) throw new Error(`No provider adapter registered for ${model.provider}`);
    return adapter;
  }

  private requireParticipants(request: OrchestrationRequest, minimum: number) {
    if (request.participants.length < minimum) {
      throw new Error(`${request.mode} mode requires at least ${minimum} participants`);
    }
  }

  private mapProviderEvent(
    runId: string,
    stepId: string,
    event: ProviderStreamEvent,
    emit?: OrchestrationEventSink,
  ) {
    if (!emit) return;

    switch (event.type) {
      case "text_delta":
        emit({ type: "text_delta", runId, stepId, delta: event.delta });
        break;
      case "status":
        emit({ type: "status", runId, stepId, message: event.message });
        break;
      case "tool_call":
        emit({ type: "tool_call", runId, stepId, id: event.id, name: event.name, input: event.input });
        break;
      case "tool_result":
        emit({ type: "tool_result", runId, stepId, id: event.id, output: event.output, isError: event.isError });
        break;
      case "citation":
        emit({ type: "citation", runId, stepId, url: event.url, title: event.title });
        break;
      case "usage":
        emit({
          type: "usage",
          runId,
          stepId,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        });
        break;
    }
  }

  private async executeStep(spec: StepSpec, runId: string, emit?: OrchestrationEventSink) {
    emit?.({
      type: "step_started",
      runId,
      stepId: spec.id,
      kind: spec.kind,
      model: spec.model,
    });

    let emittedText = false;
    const response = await this.adapterFor(spec.model).generate({
      model: spec.model.model,
      messages: [
        ...(spec.history ?? []),
        { role: "user", content: spec.prompt },
      ],
    }, event => {
      if (event.type === "text_delta" && event.delta) emittedText = true;
      this.mapProviderEvent(runId, spec.id, event, emit);
    });

    if (!emittedText && response.content) {
      emit?.({ type: "text_delta", runId, stepId: spec.id, delta: response.content });
    }

    const step: OrchestrationStep = {
      id: spec.id,
      kind: spec.kind,
      model: spec.model,
      content: response.content,
    };
    emit?.({ type: "step_completed", runId, step });
    return step;
  }

  private async independentAnswers(
    request: OrchestrationRequest,
    runId: string,
    emit?: OrchestrationEventSink,
  ) {
    return Promise.all(
      request.participants.map((model, index) => this.executeStep({
        id: makeStepId("answer", index),
        kind: "answer",
        model,
        prompt: request.prompt,
        history: request.history,
      }, runId, emit)),
    );
  }

  private routedModel(route: string, participants: ModelRef[], router: ModelRef) {
    const routeLine = route
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => /^ROUTE\s*:/i.test(line));
    const requested = routeLine
      ?.replace(/^ROUTE\s*:/i, "")
      .trim()
      .replace(/^`|`$/g, "")
      .toLowerCase();

    if (requested) {
      const exact = participants.find(model => (
        modelKey(model).toLowerCase() === requested
        || model.model.toLowerCase() === requested
        || model.label.toLowerCase() === requested
      ));
      if (exact) return exact;
    }

    return participants.find(model => !sameModel(model, router)) ?? router;
  }

  async run(request: OrchestrationRequest, options: RunOptions = {}): Promise<OrchestrationResult> {
    const runId = options.runId ?? randomUUID();
    const emit = options.emit;
    emit?.({ type: "run_started", runId, mode: request.mode });

    try {
      if (request.participants.length === 0) throw new Error("At least one participant is required");

      const complete = (result: OrchestrationResult) => {
        emit?.({ type: "run_completed", runId, result });
        return result;
      };

      if (request.mode === "single") {
        if (request.participants.length !== 1) {
          throw new Error("Single mode requires exactly one participant");
        }

        const model = request.participants[0];
        const step = await this.executeStep({
          id: makeStepId("answer", 0),
          kind: "answer",
          model,
          prompt: request.prompt,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [step], final: step.content });
      }

      if (request.mode === "critic-revise") {
        const author = request.participants[0];
        const critic = request.participants[1] ?? author;
        const draft = await this.executeStep({
          id: makeStepId("answer", 0),
          kind: "answer",
          model: author,
          prompt: request.prompt,
          history: request.history,
        }, runId, emit);
        const critique = await this.executeStep({
          id: makeStepId("critique", 0),
          kind: "critique",
          model: critic,
          prompt: `Critique this answer for factual gaps, weak reasoning, and missing alternatives.\n\nQuestion:\n${request.prompt}\n\nDraft:\n${draft.content}`,
          history: request.history,
        }, runId, emit);
        const revision = await this.executeStep({
          id: makeStepId("revision", 0),
          kind: "revision",
          model: author,
          prompt: `Revise your answer using the critique. Keep only improvements you can justify.\n\nQuestion:\n${request.prompt}\n\nDraft:\n${draft.content}\n\nCritique:\n${critique.content}`,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [draft, critique, revision], final: revision.content });
      }

      if (request.mode === "red-team") {
        const author = request.participants[0];
        const draft = await this.executeStep({
          id: makeStepId("answer", 0),
          kind: "answer",
          model: author,
          prompt: request.prompt,
          history: request.history,
        }, runId, emit);
        const critics = request.participants.slice(1);
        const redTeam = critics.length > 0 ? critics : [author];
        const critiques = await Promise.all(redTeam.map((model, index) => this.executeStep({
          id: makeStepId("red-team", index),
          kind: "critique",
          model,
          prompt: `Red-team the draft below. Look for false assumptions, counterexamples, safety or implementation failures, adversarial cases, and ways the conclusion could be wrong. Do not merely rewrite it.\n\nQuestion:\n${request.prompt}\n\nDraft:\n${draft.content}`,
          history: request.history,
        }, runId, emit)));
        const revision = await this.executeStep({
          id: makeStepId("revision", 0),
          kind: "revision",
          model: author,
          prompt: `Produce a hardened final answer after the red-team review. Address valid attacks, reject invalid ones explicitly when necessary, and preserve uncertainty.\n\nQuestion:\n${request.prompt}\n\nDraft:\n${draft.content}\n\nRed-team findings:\n${transcript(critiques, " critique")}`,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [draft, ...critiques, revision], final: revision.content });
      }

      if (request.mode === "router") {
        this.requireParticipants(request, 2);
        const router = request.participants[0];
        const choices = request.participants
          .map(model => `- ${modelKey(model)} — ${model.label}`)
          .join("\n");
        const route = await this.executeStep({
          id: makeStepId("route", 0),
          kind: "route",
          model: router,
          prompt: `Route the question to exactly one of the available models. On the first line output exactly ROUTE: provider:model using one key from the list. Then briefly explain why that model is the best fit. Do not answer the question itself.\n\nQuestion:\n${request.prompt}\n\nAvailable models:\n${choices}`,
          history: request.history,
        }, runId, emit);
        const specialist = this.routedModel(route.content, request.participants, router);
        const answer = await this.executeStep({
          id: makeStepId("answer", 0),
          kind: "answer",
          model: specialist,
          prompt: `Answer the original question directly. You were selected by a routing step; the router's note is context, not authority.\n\nQuestion:\n${request.prompt}\n\nRouter note:\n${route.content}`,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [route, answer], final: answer.content });
      }

      if (request.mode === "planner-executor") {
        const planner = request.participants[0];
        const plan = await this.executeStep({
          id: makeStepId("plan", 0),
          kind: "plan",
          model: planner,
          prompt: `Create a concrete plan for solving the question or task. Break it into ordered work items, name assumptions and dependencies, and define what a good final answer must contain. Do not pretend to perform external actions.\n\nTask:\n${request.prompt}`,
          history: request.history,
        }, runId, emit);
        const availableExecutors = request.participants.slice(1);
        const executors = availableExecutors.length > 0 ? availableExecutors : [planner];
        const executions = await Promise.all(executors.map((model, index) => this.executeStep({
          id: makeStepId("execution", index),
          kind: "execution",
          model,
          prompt: `Act as executor ${index + 1}. Carry out the parts of the plan you can solve in text, produce concrete analysis/output, and flag any plan defect you discover. Do not claim external actions or research you did not perform.\n\nTask:\n${request.prompt}\n\nPlan:\n${plan.content}`,
          history: request.history,
        }, runId, emit)));
        const reviewer = request.synthesizer ?? request.participants.at(-1) ?? planner;
        const review = await this.executeStep({
          id: makeStepId("review", 0),
          kind: "review",
          model: reviewer,
          prompt: `Review the plan and executor outputs. Resolve conflicts, correct mistakes, and return the best final answer to the original task. Do not narrate the workflow unless it helps the user.\n\nTask:\n${request.prompt}\n\nPlan:\n${plan.content}\n\nExecutor outputs:\n${transcript(executions, " execution")}`,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [plan, ...executions, review], final: review.content });
      }

      if (request.mode === "research-council") {
        this.requireParticipants(request, 2);
        const research = await Promise.all(request.participants.map((model, index) => this.executeStep({
          id: makeStepId("research", index),
          kind: "research",
          model,
          prompt: `You are one member of a research council. ${researchAngles[index % researchAngles.length]} Use only knowledge and context actually available to you; do not claim that you browsed, ran experiments, or consulted sources unless that happened in this run. Clearly mark uncertainty.\n\nQuestion:\n${request.prompt}`,
          history: request.history,
        }, runId, emit)));
        const synthesizer = request.synthesizer ?? request.participants[0];
        const synthesis = await this.executeStep({
          id: makeStepId("synthesis", 0),
          kind: "synthesis",
          model: synthesizer,
          prompt: `Synthesize the council reports into a rigorous answer. Reconcile compatible findings, preserve material disagreements, distinguish evidence from inference, and state what remains unknown. Do not invent citations or imply external research occurred.\n\nQuestion:\n${request.prompt}\n\nCouncil reports:\n${transcript(research, " report")}`,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [...research, synthesis], final: synthesis.content });
      }

      if (request.mode === "judge" || request.mode === "consensus") {
        this.requireParticipants(request, 2);
      }

      const independent = await this.independentAnswers(request, runId, emit);

      if (request.mode === "compare") {
        return complete({
          mode: request.mode,
          steps: independent,
          final: independent.map(step => step.content).join("\n\n---\n\n"),
        });
      }

      const synthesizer = request.synthesizer ?? request.participants[0];
      const answersTranscript = transcript(independent);

      if (request.mode === "panel") {
        const synthesis = await this.executeStep({
          id: makeStepId("synthesis", 0),
          kind: "synthesis",
          model: synthesizer,
          prompt: `Synthesize the independent answers below. Preserve useful disagreements and do not invent consensus.\n\nQuestion:\n${request.prompt}\n\nAnswers:\n${answersTranscript}`,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [...independent, synthesis], final: synthesis.content });
      }

      if (request.mode === "judge") {
        const judgment = await this.executeStep({
          id: makeStepId("judgment", 0),
          kind: "judgment",
          model: synthesizer,
          prompt: `Act as a judge. Evaluate the candidate answers for correctness, reasoning quality, completeness, calibration, and usefulness. Select or combine only the best-supported material and return the final answer to the user. Mention a material unresolved disagreement if it changes the recommendation.\n\nQuestion:\n${request.prompt}\n\nCandidates:\n${answersTranscript}`,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [...independent, judgment], final: judgment.content });
      }

      if (request.mode === "consensus") {
        const synthesis = await this.executeStep({
          id: makeStepId("synthesis", 0),
          kind: "synthesis",
          model: synthesizer,
          prompt: `Build a candidate consensus from these independent answers. Include only claims supported by multiple positions or strongly justified by one position. Explicitly retain important dissent rather than forcing agreement.\n\nQuestion:\n${request.prompt}\n\nAnswers:\n${answersTranscript}`,
          history: request.history,
        }, runId, emit);
        const verifier = request.participants.find(model => !sameModel(model, synthesizer)) ?? request.participants[0];
        const review = await this.executeStep({
          id: makeStepId("review", 0),
          kind: "review",
          model: verifier,
          prompt: `Audit the proposed consensus against the original independent answers. Remove false consensus, restore meaningful dissent, correct unsupported claims, and then output the corrected final answer.\n\nQuestion:\n${request.prompt}\n\nIndependent answers:\n${answersTranscript}\n\nProposed consensus:\n${synthesis.content}`,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [...independent, synthesis, review], final: review.content });
      }

      if (request.mode === "debate") {
        const maxRounds = Math.max(1, Math.min(request.maxRounds ?? 1, 3));
        const debateSteps: OrchestrationStep[] = [...independent];
        let debateTranscript = answersTranscript;

        for (let round = 0; round < maxRounds; round += 1) {
          const critiques = await Promise.all(
            request.participants.map((model, index) => this.executeStep({
              id: makeStepId(`critique-r${round + 1}`, index),
              kind: "critique",
              model,
              prompt: `You are in debate round ${round + 1}. Identify the strongest disagreement or weakness in the other positions and state what should change.\n\nQuestion:\n${request.prompt}\n\nCurrent positions:\n${debateTranscript}`,
              history: request.history,
            }, runId, emit)),
          );
          debateSteps.push(...critiques);
          debateTranscript += "\n\n" + critiques
            .map(step => `${step.model.label} critique:\n${step.content}`)
            .join("\n\n");
        }

        const synthesis = await this.executeStep({
          id: makeStepId("synthesis", 0),
          kind: "synthesis",
          model: synthesizer,
          prompt: `Judge the debate. Produce the best-supported answer, explicitly noting unresolved disagreements and uncertainty.\n\nQuestion:\n${request.prompt}\n\nDebate:\n${debateTranscript}`,
          history: request.history,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [...debateSteps, synthesis], final: synthesis.content });
      }

      throw new Error(`Unsupported orchestration mode: ${request.mode}`);
    } catch (error) {
      emit?.({
        type: "error",
        runId,
        message: error instanceof Error ? error.message : "Unknown orchestration error",
      });
      throw error;
    }
  }
}
