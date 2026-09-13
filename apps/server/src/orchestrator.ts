import { randomUUID } from "node:crypto";
import type {
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
};

export class Orchestrator {
  constructor(private readonly providers: Map<string, ProviderAdapter>) {}

  private adapterFor(model: ModelRef) {
    const adapter = this.providers.get(model.provider);
    if (!adapter) throw new Error(`No provider adapter registered for ${model.provider}`);
    return adapter;
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
      messages: [{ role: "user", content: spec.prompt }],
    }, event => {
      if (event.type === "text_delta" && event.delta) emittedText = true;
      this.mapProviderEvent(runId, spec.id, event, emit);
    });

    // Providers that cannot expose token/chunk streaming yet still participate
    // in the same protocol with one complete text delta at the end.
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
        }, runId, emit);
        const critique = await this.executeStep({
          id: makeStepId("critique", 0),
          kind: "critique",
          model: critic,
          prompt: `Critique this answer for factual gaps, weak reasoning, and missing alternatives.\n\nQuestion:\n${request.prompt}\n\nDraft:\n${draft.content}`,
        }, runId, emit);
        const revision = await this.executeStep({
          id: makeStepId("revision", 0),
          kind: "revision",
          model: author,
          prompt: `Revise your answer using the critique. Keep only improvements you can justify.\n\nQuestion:\n${request.prompt}\n\nDraft:\n${draft.content}\n\nCritique:\n${critique.content}`,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [draft, critique, revision], final: revision.content });
      }

      const independent = await Promise.all(
        request.participants.map((model, index) => this.executeStep({
          id: makeStepId("answer", index),
          kind: "answer",
          model,
          prompt: request.prompt,
        }, runId, emit)),
      );

      if (request.mode === "compare") {
        return complete({
          mode: request.mode,
          steps: independent,
          final: independent.map(step => step.content).join("\n\n---\n\n"),
        });
      }

      const synthesizer = request.synthesizer ?? request.participants[0];
      const transcript = independent
        .map(step => `${step.model.label}:\n${step.content}`)
        .join("\n\n");

      if (request.mode === "panel") {
        const synthesis = await this.executeStep({
          id: makeStepId("synthesis", 0),
          kind: "synthesis",
          model: synthesizer,
          prompt: `Synthesize the independent answers below. Preserve useful disagreements and do not invent consensus.\n\nQuestion:\n${request.prompt}\n\nAnswers:\n${transcript}`,
        }, runId, emit);
        return complete({ mode: request.mode, steps: [...independent, synthesis], final: synthesis.content });
      }

      const maxRounds = Math.max(1, Math.min(request.maxRounds ?? 1, 3));
      const debateSteps: OrchestrationStep[] = [...independent];
      let debateTranscript = transcript;

      for (let round = 0; round < maxRounds; round += 1) {
        const critiques = await Promise.all(
          request.participants.map((model, index) => this.executeStep({
            id: makeStepId(`critique-r${round + 1}`, index),
            kind: "critique",
            model,
            prompt: `You are in debate round ${round + 1}. Identify the strongest disagreement or weakness in the other positions and state what should change.\n\nQuestion:\n${request.prompt}\n\nCurrent positions:\n${debateTranscript}`,
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
      }, runId, emit);
      return complete({ mode: request.mode, steps: [...debateSteps, synthesis], final: synthesis.content });
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
