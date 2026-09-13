import type { WorkflowPreset } from "@conclave/core";

export const workflowPresets: WorkflowPreset[] = [
  {
    id: "triangulate",
    name: "Triangulate",
    description: "Two independent analyses run in parallel, then a synthesizer reconciles them.",
    graph: {
      id: "triangulate",
      name: "Triangulate",
      description: "Parallel analysis followed by synthesis.",
      outputNodeId: "synthesis",
      nodes: [
        {
          id: "analysis-a",
          kind: "answer",
          model: { type: "participant", index: 0 },
          promptTemplate: "Analyze the task independently. Focus on the strongest answer you can justify, including important assumptions and uncertainty.\n\nTask:\n{{prompt}}",
        },
        {
          id: "analysis-b",
          kind: "answer",
          model: { type: "participant", index: 1 },
          promptTemplate: "Analyze the task independently from another angle. Look for alternatives, edge cases, and weaknesses a first analyst may miss.\n\nTask:\n{{prompt}}",
        },
        {
          id: "synthesis",
          kind: "synthesis",
          model: { type: "synthesizer" },
          dependsOn: ["analysis-a", "analysis-b"],
          promptTemplate: "Synthesize the upstream analyses into the best final answer. Preserve meaningful disagreement and uncertainty instead of forcing consensus.\n\nOriginal task:\n{{prompt}}\n\nUpstream analyses:\n{{dependencies}}",
        },
      ],
    },
  },
  {
    id: "challenge-revise",
    name: "Challenge → Revise",
    description: "Draft an answer, challenge it with a second model, then revise the original draft.",
    graph: {
      id: "challenge-revise",
      name: "Challenge → Revise",
      description: "Draft, critique, and revision chain.",
      outputNodeId: "revision",
      nodes: [
        {
          id: "draft",
          kind: "answer",
          model: { type: "participant", index: 0 },
          promptTemplate: "Produce a strong first-pass answer to the task.\n\nTask:\n{{prompt}}",
        },
        {
          id: "challenge",
          kind: "critique",
          model: { type: "participant", index: 1 },
          dependsOn: ["draft"],
          promptTemplate: "Challenge the draft below. Identify factual gaps, weak assumptions, missing alternatives, and concrete improvements.\n\nTask:\n{{prompt}}\n\nDraft:\n{{dep.draft}}",
        },
        {
          id: "revision",
          kind: "revision",
          model: { type: "participant", index: 0 },
          dependsOn: ["draft", "challenge"],
          promptTemplate: "Produce the final answer. Incorporate valid criticism, reject weak criticism when justified, and keep the answer focused on the original task.\n\nTask:\n{{prompt}}\n\nDraft:\n{{dep.draft}}\n\nChallenge:\n{{dep.challenge}}",
        },
      ],
    },
  },
  {
    id: "decision-board",
    name: "Decision Board",
    description: "One model develops options, another stress-tests risks, then a synthesizer makes the decision memo.",
    graph: {
      id: "decision-board",
      name: "Decision Board",
      description: "Options and risks in parallel, followed by a decision memo.",
      outputNodeId: "decision",
      nodes: [
        {
          id: "options",
          kind: "research",
          model: { type: "participant", index: 0 },
          promptTemplate: "Develop the strongest feasible options for the task. Compare tradeoffs, dependencies, and likely outcomes.\n\nTask:\n{{prompt}}",
        },
        {
          id: "risks",
          kind: "critique",
          model: { type: "participant", index: 1 },
          promptTemplate: "Act as a risk reviewer. Identify failure modes, hidden costs, reversibility concerns, and information that could change the decision.\n\nTask:\n{{prompt}}",
        },
        {
          id: "decision",
          kind: "judgment",
          model: { type: "synthesizer" },
          dependsOn: ["options", "risks"],
          promptTemplate: "Write a concise decision memo for the original task. Weigh options against the risk review, make a recommendation when justified, and state what remains uncertain.\n\nTask:\n{{prompt}}\n\nBoard material:\n{{dependencies}}",
        },
      ],
    },
  },
];
