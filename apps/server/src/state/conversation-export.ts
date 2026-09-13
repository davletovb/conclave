import type { ConversationExport, ConversationExportRun, ModelRef } from "@conclave/core";

function modelLine(model: ModelRef) {
  return `${model.label} (${model.provider}/${model.model})`;
}

function fence(content: string) {
  // A model can legitimately emit ``` inside its answer. Grow the fence past
  // the longest run already present so the export stays parseable.
  const longest = [...content.matchAll(/`{3,}/g)].reduce((max, match) => Math.max(max, match[0].length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

function runHeading(run: ConversationExportRun) {
  const roles = run.participants.map(modelLine).join(", ") || "none recorded";
  const lines = [
    `- Mode: ${run.mode}`,
    `- Status: ${run.status}${run.attempt > 1 ? ` (attempt ${run.attempt})` : ""}`,
    `- Participants: ${roles}`,
  ];
  if (run.synthesizer) lines.push(`- Finalizer: ${modelLine(run.synthesizer)}`);
  if (run.workflow) lines.push(`- Workflow: ${run.workflow.name} (${run.workflow.nodes.length} nodes)`);
  lines.push(`- Calls: ${run.usage.callsCompleted}/${run.usage.callsStarted} completed`);
  if (run.usage.tokenReports > 0) {
    lines.push(`- Tokens: ${run.usage.inputTokens} in / ${run.usage.outputTokens} out`);
  }
  if (run.error) lines.push(`- Error: ${run.error}`);
  return lines.join("\n");
}

function stepSections(run: ConversationExportRun) {
  const out: string[] = [];
  for (const step of run.steps) {
    const after = step.dependsOn && step.dependsOn.length > 0 ? ` · after ${step.dependsOn.join(", ")}` : "";
    const marks = fence(step.content);
    out.push(
      "",
      `### ${step.id} · ${step.kind} · ${modelLine(step.model)}${after}`,
      "",
      `${marks}markdown`,
      step.content.trim() || "(no output recorded)",
      marks,
    );
  }
  return out;
}

/**
 * Render a conversation and the reasoning behind it as one self-contained
 * Markdown document. Council work is included so an export keeps the evidence,
 * not only the conclusion.
 */
export function exportToMarkdown(data: ConversationExport) {
  const { conversation } = data;
  const runsById = new Map(data.runs.map(run => [run.id, run]));
  const out: string[] = [
    `# ${conversation.title}`,
    "",
    `_Exported from Conclave on ${data.exportedAt}. Started ${conversation.createdAt}, last updated ${conversation.updatedAt}._`,
  ];

  for (const message of conversation.messages) {
    out.push("", "---", "");
    if (message.role === "user") {
      out.push("## You", "", message.content.trim() || "_(empty prompt)_");
      continue;
    }

    out.push("## Conclave", "", message.content.trim() || "_(no final answer recorded)_");

    const run = message.runId ? runsById.get(message.runId) : undefined;
    if (!run) continue;

    out.push("", "<details>", "<summary>Council work</summary>", "", runHeading(run), ...stepSections(run), "", "</details>");
  }

  // Runs that never produced an assistant message (failed, cancelled, still
  // running) would otherwise vanish from the export entirely. Only an
  // assistant message counts as answered: the user turn carries the same runId.
  const answered = new Set(conversation.messages
    .filter(message => message.role === "assistant")
    .map(message => message.runId)
    .filter(Boolean));
  const unanswered = data.runs.filter(run => !answered.has(run.id));
  if (unanswered.length > 0) {
    out.push("", "---", "", "## Runs without a final answer", "");
    for (const run of unanswered) {
      // Whatever these runs did finish is still evidence, so it travels with
      // them rather than leaving only the metadata behind.
      out.push(`### Run ${run.id}`, "", runHeading(run), ...stepSections(run), "");
    }
  }

  return `${out.join("\n").trimEnd()}\n`;
}

export function exportFilename(title: string, format: "markdown" | "json") {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "conversation";
  return `conclave-${slug}.${format === "markdown" ? "md" : "json"}`;
}
