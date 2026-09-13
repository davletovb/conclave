import { describe, expect, it } from "vitest";
import type { WorkflowGraph } from "@conclave/core";
import {
  addNode,
  canDependOn,
  emptyWorkflow,
  graphLayers,
  parseWorkflow,
  removeNode,
  renameNode,
  requiredParticipants,
  serializeWorkflow,
  setOutputNode,
  toggleDependency,
  validateWorkflow,
} from "./workflow-model";

function graph(): WorkflowGraph {
  return {
    name: "Triangulate",
    nodes: [
      { id: "a", kind: "answer", model: { type: "participant", index: 0 }, promptTemplate: "{{prompt}}" },
      { id: "b", kind: "answer", model: { type: "participant", index: 1 }, promptTemplate: "{{prompt}}" },
      {
        id: "final",
        kind: "synthesis",
        model: { type: "synthesizer" },
        dependsOn: ["a", "b"],
        promptTemplate: "{{dep.a}} {{dep.b}}",
      },
    ],
    outputNodeId: "final",
  };
}

describe("parseWorkflow", () => {
  it("accepts a well-formed graph", () => {
    const parsed = parseWorkflow(serializeWorkflow(graph()));
    expect(parsed.error).toBe("");
    expect(parsed.graph?.nodes).toHaveLength(3);
  });

  it("explains what is wrong instead of failing silently", () => {
    expect(parseWorkflow("").error).toMatch(/preset or start/);
    expect(parseWorkflow("[]").error).toMatch(/must be an object/);
    expect(parseWorkflow("{oops}").error).toMatch(/Invalid workflow JSON/);
    expect(parseWorkflow(JSON.stringify({ name: "x", nodes: [], outputNodeId: "a" })).error).toMatch(/at least one node/);
  });

  it("rejects cycles, hidden references and orphans", () => {
    const cyclic = graph();
    cyclic.nodes[0].dependsOn = ["final"];
    expect(validateWorkflow(cyclic).error).toMatch(/cycle/);

    const hidden = graph();
    hidden.nodes[1].promptTemplate = "{{dep.a}}";
    expect(validateWorkflow(hidden).error).toMatch(/without declaring it/);

    const orphan = toggleDependency(graph(), "final", "b");
    expect(validateWorkflow(orphan).error).toMatch(/not connected to the output: b/);

    const missingOutput = setOutputNode(graph(), "nope");
    expect(validateWorkflow(missingOutput).error).toMatch(/does not exist/);
  });

  it("rejects malformed node fields", () => {
    const badId = graph();
    badId.nodes[0].id = "1bad";
    expect(validateWorkflow(badId).error).toMatch(/Invalid node ID/);

    const badKind = graph();
    (badKind.nodes[0] as { kind: string }).kind = "vibes";
    expect(validateWorkflow(badKind).error).toMatch(/unsupported kind/);

    const badModel = graph();
    (badModel.nodes[0] as { model: unknown }).model = { type: "participant", index: -1 };
    expect(validateWorkflow(badModel).error).toMatch(/invalid participant index/);

    const duplicate = graph();
    duplicate.nodes[1].id = "a";
    expect(validateWorkflow(duplicate).error).toMatch(/duplicated/);
  });
});

describe("graph editing", () => {
  it("starts from a runnable two-node workflow", () => {
    expect(validateWorkflow(emptyWorkflow()).error).toBe("");
  });

  it("adds nodes with unique ids and keeps the graph parseable once wired up", () => {
    const added = addNode(graph(), "critique");
    expect(added.nodes.at(-1)?.id).toBe("critique");
    const twice = addNode(added, "critique");
    expect(twice.nodes.at(-1)?.id).toBe("critique-2");
    // A brand new node is not yet connected to the output, which the editor
    // surfaces as a validation error until the user wires it in.
    expect(validateWorkflow(twice).error).toMatch(/not connected/);
    expect(validateWorkflow(toggleDependency(
      toggleDependency(twice, "final", "critique"),
      "final",
      "critique-2",
    )).error).toBe("");
  });

  it("removes a node from dependencies and reassigns the output", () => {
    const removed = removeNode(graph(), "b");
    expect(removed.nodes.map(node => node.id)).toEqual(["a", "final"]);
    expect(removed.nodes.find(node => node.id === "final")?.dependsOn).toEqual(["a"]);

    const withoutOutput = removeNode(graph(), "final");
    expect(withoutOutput.outputNodeId).toBe("b");
  });

  it("rewrites dependencies, templates and the output when a node is renamed", () => {
    const renamed = renameNode(graph(), "a", "evidence");
    const final = renamed.nodes.find(node => node.id === "final")!;
    expect(renamed.nodes.map(node => node.id)).toEqual(["evidence", "b", "final"]);
    expect(final.dependsOn).toEqual(["evidence", "b"]);
    expect(final.promptTemplate).toBe("{{dep.evidence}} {{dep.b}}");
    expect(validateWorkflow(renamed).error).toBe("");

    const renamedOutput = renameNode(graph(), "final", "verdict");
    expect(renamedOutput.outputNodeId).toBe("verdict");
  });

  it("drops the template reference when a dependency is removed", () => {
    const detached = toggleDependency(graph(), "final", "a");
    const final = detached.nodes.find(node => node.id === "final")!;
    expect(final.dependsOn).toEqual(["b"]);
    expect(final.promptTemplate).not.toContain("{{dep.a}}");
  });

  it("refuses a dependency that would close a cycle", () => {
    expect(canDependOn(graph(), "final", "a")).toBe(true);
    expect(canDependOn(graph(), "a", "final")).toBe(false);
    expect(canDependOn(graph(), "a", "a")).toBe(false);
    expect(toggleDependency(graph(), "a", "final")).toEqual(graph());
  });

  it("reports participant slots and execution layers", () => {
    expect(requiredParticipants(graph())).toBe(2);
    expect(requiredParticipants(undefined)).toBe(1);
    expect(graphLayers(graph())).toEqual([["a", "b"], ["final"]]);
  });
});
