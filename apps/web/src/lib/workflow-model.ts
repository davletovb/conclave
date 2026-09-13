import type { OrchestrationStepKind, WorkflowGraph, WorkflowNode } from "@conclave/core";

export const workflowKinds: OrchestrationStepKind[] = [
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
];

const kindSet = new Set<string>(workflowKinds);
const NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_NODES = 64;

export type ParsedWorkflow = {
  /** Structurally sound and valid to run. */
  graph?: WorkflowGraph;
  /**
   * Structurally sound enough to keep editing, even when a rule below fails.
   * An edit that transiently disconnects a node must not take the editor away
   * from the user and leave them with only the raw JSON.
   */
  draft?: WorkflowGraph;
  error: string;
};

/**
 * Mirrors the server's graph validation so the editor can refuse a run before
 * it costs a subscription call. The server remains the authority.
 */
export function parseWorkflow(raw: string): ParsedWorkflow {
  if (!raw.trim()) return { error: "Choose a preset or start a workflow graph." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { error: cause instanceof Error ? `Invalid workflow JSON: ${cause.message}` : "Invalid workflow JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Workflow JSON must be an object." };
  }
  return validateWorkflow(parsed as WorkflowGraph);
}

export function validateWorkflow(graph: WorkflowGraph): ParsedWorkflow {
  if (typeof graph.name !== "string" || !graph.name.trim()) return { error: "Workflow needs a name." };
  if (!Array.isArray(graph.nodes)) return { error: "Workflow needs a nodes array." };
  if (typeof graph.outputNodeId !== "string" || !graph.outputNodeId.trim()) {
    return { error: "Workflow needs an output node." };
  }
  if (graph.nodes.length === 0) return { error: "Workflow must contain at least one node." };
  if (graph.nodes.length > MAX_NODES) return { error: `Workflow cannot contain more than ${MAX_NODES} nodes.` };

  const byId = new Map<string, WorkflowNode>();
  for (const candidate of graph.nodes) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { error: "Every workflow node must be an object." };
    }
    if (typeof candidate.id !== "string" || !NODE_ID.test(candidate.id)) {
      return { error: `Invalid node ID '${String(candidate.id)}'. Use letters, digits, - and _.` };
    }
    if (byId.has(candidate.id)) return { error: `Node '${candidate.id}' is duplicated.` };
    if (typeof candidate.kind !== "string" || !kindSet.has(candidate.kind)) {
      return { error: `Node '${candidate.id}' has unsupported kind '${String(candidate.kind)}'.` };
    }
    if (typeof candidate.promptTemplate !== "string" || !candidate.promptTemplate.trim()) {
      return { error: `Node '${candidate.id}' needs a prompt template.` };
    }
    if (!candidate.model || typeof candidate.model !== "object" || Array.isArray(candidate.model)) {
      return { error: `Node '${candidate.id}' needs a model selector.` };
    }
    if (candidate.model.type === "participant") {
      if (!Number.isInteger(candidate.model.index) || candidate.model.index < 0) {
        return { error: `Node '${candidate.id}' has an invalid participant index.` };
      }
    } else if (candidate.model.type !== "synthesizer") {
      return { error: `Node '${candidate.id}' has an unsupported model selector.` };
    }
    if (candidate.dependsOn !== undefined && !Array.isArray(candidate.dependsOn)) {
      return { error: `Node '${candidate.id}' dependsOn must be an array.` };
    }
    if ((candidate.dependsOn ?? []).some(dependency => typeof dependency !== "string")) {
      return { error: `Node '${candidate.id}' dependencies must be node IDs.` };
    }
    byId.set(candidate.id, candidate);
  }

  // Past this point the graph can be rendered and edited, so every remaining
  // rule reports its error alongside a draft the editor keeps working on.
  const draft = graph;

  if (!byId.has(graph.outputNodeId)) {
    return { draft, error: `Output node '${graph.outputNodeId}' does not exist.` };
  }

  for (const node of graph.nodes) {
    const dependencies = node.dependsOn ?? [];
    if (new Set(dependencies).size !== dependencies.length) {
      return { draft, error: `Node '${node.id}' contains duplicate dependencies.` };
    }
    for (const dependency of dependencies) {
      if (dependency === node.id) return { draft, error: `Node '${node.id}' cannot depend on itself.` };
      if (!byId.has(dependency)) return { draft, error: `Node '${node.id}' depends on missing node '${dependency}'.` };
    }
    const hidden = explicitDependencyRefs(node.promptTemplate).find(reference => !dependencies.includes(reference));
    if (hidden) return { draft, error: `Node '${node.id}' uses {{dep.${hidden}}} without declaring it.` };
  }

  const state = new Map<string, "visiting" | "done">();
  const visit = (nodeId: string): boolean => {
    const current = state.get(nodeId);
    if (current === "visiting") return false;
    if (current === "done") return true;
    state.set(nodeId, "visiting");
    for (const dependency of byId.get(nodeId)?.dependsOn ?? []) {
      if (!visit(dependency)) return false;
    }
    state.set(nodeId, "done");
    return true;
  };
  if (!graph.nodes.every(node => visit(node.id))) {
    return { draft, error: "Workflow graph contains a dependency cycle." };
  }

  const reachable = ancestorsOf(graph, graph.outputNodeId);
  const unused = graph.nodes.filter(node => !reachable.has(node.id)).map(node => node.id);
  if (unused.length > 0) {
    return { draft, error: `Node${unused.length === 1 ? "" : "s"} not connected to the output: ${unused.join(", ")}.` };
  }

  return { graph, draft, error: "" };
}

function dropDependencyReference(template: string, nodeId: string) {
  return template.split(`{{dep.${nodeId}}}`).join("").replace(/\n{3,}/g, "\n\n");
}

/** A node ID the editor and the server will both accept. */
export function isValidNodeId(id: string) {
  return NODE_ID.test(id);
}

export function explicitDependencyRefs(template: string) {
  return [...template.matchAll(/\{\{dep\.([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/g)].map(match => match[1]);
}

function ancestorsOf(graph: WorkflowGraph, nodeId: string) {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) walk(dependency);
  };
  walk(nodeId);
  return seen;
}

function descendantsOf(graph: WorkflowGraph, nodeId: string) {
  const seen = new Set<string>([nodeId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of graph.nodes) {
      if (seen.has(node.id)) continue;
      if ((node.dependsOn ?? []).some(dependency => seen.has(dependency))) {
        seen.add(node.id);
        grew = true;
      }
    }
  }
  return seen;
}

/** A node may depend on anything that is not downstream of it. */
export function canDependOn(graph: WorkflowGraph, nodeId: string, candidateId: string) {
  if (nodeId === candidateId) return false;
  return !descendantsOf(graph, nodeId).has(candidateId);
}

export function requiredParticipants(graph?: WorkflowGraph) {
  if (!graph) return 1;
  const indexes = graph.nodes
    .filter(node => node?.model?.type === "participant")
    .map(node => (node.model.type === "participant" ? node.model.index : -1));
  return Math.max(1, ...indexes.map(index => index + 1));
}

/** Dependency depth per node, so the editor can draw the execution order. */
export function graphLayers(graph: WorkflowGraph): string[][] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const depth = new Map<string, number>();
  const resolve = (id: string, trail: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (trail.has(id)) return 0;
    trail.add(id);
    const dependencies = byId.get(id)?.dependsOn ?? [];
    const value = dependencies.length === 0
      ? 0
      : Math.max(...dependencies.map(dependency => resolve(dependency, trail) + 1));
    trail.delete(id);
    depth.set(id, value);
    return value;
  };

  const layers: string[][] = [];
  for (const node of graph.nodes) {
    const level = resolve(node.id, new Set());
    (layers[level] ??= []).push(node.id);
  }
  return layers.map(layer => layer ?? []);
}

function uniqueId(graph: WorkflowGraph, base: string) {
  const taken = new Set(graph.nodes.map(node => node.id));
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function emptyWorkflow(): WorkflowGraph {
  return {
    name: "New workflow",
    description: "",
    nodes: [
      {
        id: "answer",
        kind: "answer",
        model: { type: "participant", index: 0 },
        promptTemplate: "{{prompt}}",
      },
      {
        id: "final",
        kind: "synthesis",
        model: { type: "synthesizer" },
        dependsOn: ["answer"],
        promptTemplate: "Task:\n{{prompt}}\n\nDraft:\n{{dep.answer}}\n\nReturn the best final answer.",
      },
    ],
    outputNodeId: "final",
  };
}

export function addNode(graph: WorkflowGraph, kind: OrchestrationStepKind = "answer"): WorkflowGraph {
  const id = uniqueId(graph, kind);
  const node: WorkflowNode = {
    id,
    kind,
    model: { type: "participant", index: Math.max(0, requiredParticipants(graph) - 1) },
    promptTemplate: "{{prompt}}",
  };

  // Wire the new node into the output so the graph stays runnable the moment it
  // appears; it has no dependencies of its own, so this can never form a cycle.
  const nodes = [...graph.nodes, node].map(candidate => (candidate.id === graph.outputNodeId
    ? { ...candidate, dependsOn: [...(candidate.dependsOn ?? []), id] }
    : candidate));
  return { ...graph, nodes };
}

export function removeNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  // A surviving {{dep.<removed>}} reference is an undeclared dependency, which
  // invalidates the graph the moment the node disappears.
  const nodes = graph.nodes
    .filter(node => node.id !== nodeId)
    .map(node => ({
      ...node,
      dependsOn: node.dependsOn?.filter(dependency => dependency !== nodeId),
      promptTemplate: dropDependencyReference(node.promptTemplate, nodeId),
    }));
  const outputNodeId = graph.outputNodeId === nodeId ? (nodes.at(-1)?.id ?? "") : graph.outputNodeId;
  return { ...graph, nodes, outputNodeId };
}

export function updateNode(graph: WorkflowGraph, nodeId: string, patch: Partial<WorkflowNode>): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(node => (node.id === nodeId ? { ...node, ...patch } : node)),
  };
}

/** Renaming rewrites dependencies, {{dep.x}} references and the output node. */
export function renameNode(graph: WorkflowGraph, from: string, to: string): WorkflowGraph {
  if (from === to) return graph;
  const nodes = graph.nodes.map(node => {
    const next: WorkflowNode = { ...node };
    if (next.id === from) next.id = to;
    if (next.dependsOn?.includes(from)) {
      next.dependsOn = next.dependsOn.map(dependency => (dependency === from ? to : dependency));
    }
    if (next.promptTemplate.includes(`{{dep.${from}}}`)) {
      next.promptTemplate = next.promptTemplate.split(`{{dep.${from}}}`).join(`{{dep.${to}}}`);
    }
    return next;
  });
  return { ...graph, nodes, outputNodeId: graph.outputNodeId === from ? to : graph.outputNodeId };
}

export function toggleDependency(graph: WorkflowGraph, nodeId: string, dependencyId: string): WorkflowGraph {
  const node = graph.nodes.find(candidate => candidate.id === nodeId);
  if (!node) return graph;
  const current = node.dependsOn ?? [];
  if (current.includes(dependencyId)) {
    const dependsOn = current.filter(dependency => dependency !== dependencyId);
    // A template reference without its declaration is invalid, so drop both.
    const promptTemplate = dropDependencyReference(node.promptTemplate, dependencyId);
    return updateNode(graph, nodeId, { dependsOn, promptTemplate });
  }
  if (!canDependOn(graph, nodeId, dependencyId)) return graph;
  return updateNode(graph, nodeId, { dependsOn: [...current, dependencyId] });
}

export function setOutputNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  return { ...graph, outputNodeId: nodeId };
}

export function serializeWorkflow(graph: WorkflowGraph) {
  return JSON.stringify(graph, null, 2);
}
