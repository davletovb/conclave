import type {
  ModelRef,
  OrchestrationRequest,
  OrchestrationResult,
  OrchestrationStep,
  ProviderAdapter,
} from "@conclave/core";
import { makeStepId } from "@conclave/core";

export class Orchestrator {
  constructor(private readonly providers: Map<string, ProviderAdapter>) {}

  private adapterFor(model: ModelRef) {
    const adapter = this.providers.get(model.provider);
    if (!adapter) throw new Error(`No provider adapter registered for ${model.provider}`);
    return adapter;
  }

  private async ask(model: ModelRef, prompt: string) {
    return this.adapterFor(model).generate({
      model: model.model,
      messages: [{ role: "user", content: prompt }],
    });
  }

  async run(request: OrchestrationRequest): Promise<OrchestrationResult> {
    if (request.participants.length === 0) throw new Error("At least one participant is required");

    if (request.mode === "single") {
      const model = request.participants[0];
      const response = await this.ask(model, request.prompt);
      const step: OrchestrationStep = {
        id: makeStepId("answer", 0), kind: "answer", model, content: response.content,
      };
      return { mode: request.mode, steps: [step], final: response.content };
    }

    const independent = await Promise.all(
      request.participants.map(async (model, index) => {
        const response = await this.ask(model, request.prompt);
        return {
          id: makeStepId("answer", index),
          kind: "answer" as const,
          model,
          content: response.content,
        };
      }),
    );

    if (request.mode === "compare") {
      return { mode: request.mode, steps: independent, final: independent.map(s => s.content).join("\n\n---\n\n") };
    }

    const synthesizer = request.synthesizer ?? request.participants[0];
    const transcript = independent
      .map(step => `${step.model.label}:\n${step.content}`)
      .join("\n\n");

    if (request.mode === "panel") {
      const synthesis = await this.ask(
        synthesizer,
        `Synthesize the independent answers below. Preserve useful disagreements and do not invent consensus.\n\nQuestion:\n${request.prompt}\n\nAnswers:\n${transcript}`,
      );
      const finalStep: OrchestrationStep = {
        id: makeStepId("synthesis", 0), kind: "synthesis", model: synthesizer, content: synthesis.content,
      };
      return { mode: request.mode, steps: [...independent, finalStep], final: synthesis.content };
    }

    if (request.mode === "critic-revise") {
      const author = request.participants[0];
      const critic = request.participants[1] ?? request.participants[0];
      const draft = independent[0];
      const critiqueResponse = await this.ask(
        critic,
        `Critique this answer for factual gaps, weak reasoning, and missing alternatives.\n\nQuestion:\n${request.prompt}\n\nDraft:\n${draft.content}`,
      );
      const critique: OrchestrationStep = {
        id: makeStepId("critique", 0), kind: "critique", model: critic, content: critiqueResponse.content,
      };
      const revisionResponse = await this.ask(
        author,
        `Revise your answer using the critique. Keep only improvements you can justify.\n\nQuestion:\n${request.prompt}\n\nDraft:\n${draft.content}\n\nCritique:\n${critique.content}`,
      );
      const revision: OrchestrationStep = {
        id: makeStepId("revision", 0), kind: "revision", model: author, content: revisionResponse.content,
      };
      return { mode: request.mode, steps: [draft, critique, revision], final: revision.content };
    }

    const maxRounds = Math.max(1, Math.min(request.maxRounds ?? 1, 3));
    const debateSteps: OrchestrationStep[] = [...independent];
    let debateTranscript = transcript;

    for (let round = 0; round < maxRounds; round += 1) {
      const critiques = await Promise.all(
        request.participants.map(async (model, index) => {
          const response = await this.ask(
            model,
            `You are in debate round ${round + 1}. Identify the strongest disagreement or weakness in the other positions and state what should change.\n\nQuestion:\n${request.prompt}\n\nCurrent positions:\n${debateTranscript}`,
          );
          return {
            id: makeStepId(`critique-r${round + 1}`, index),
            kind: "critique" as const,
            model,
            content: response.content,
          };
        }),
      );
      debateSteps.push(...critiques);
      debateTranscript += "\n\n" + critiques.map(step => `${step.model.label} critique:\n${step.content}`).join("\n\n");
    }

    const synthesis = await this.ask(
      synthesizer,
      `Judge the debate. Produce the best-supported answer, explicitly noting unresolved disagreements and uncertainty.\n\nQuestion:\n${request.prompt}\n\nDebate:\n${debateTranscript}`,
    );
    const finalStep: OrchestrationStep = {
      id: makeStepId("synthesis", 0), kind: "synthesis", model: synthesizer, content: synthesis.content,
    };
    return { mode: request.mode, steps: [...debateSteps, finalStep], final: synthesis.content };
  }
}
