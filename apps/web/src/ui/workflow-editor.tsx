import React, { useEffect, useRef, useState } from "react";
import type { ModelRef, OrchestrationStepKind, WorkflowGraph, WorkflowPreset } from "@conclave/core";
import {
  addNode,
  canDependOn,
  emptyWorkflow,
  graphLayers,
  removeNode,
  renameNode,
  requiredParticipants,
  serializeWorkflow,
  setOutputNode,
  toggleDependency,
  updateNode,
  workflowKinds,
} from "../lib/workflow-model";
import { Icon, ModelIdentity, stepKindLabel } from "./primitives";

type EditorProps = {
  graph?: WorkflowGraph;
  text: string;
  error: string;
  presets: WorkflowPreset[];
  selectedPresetId: string;
  participants: ModelRef[];
  synthesizer?: ModelRef;
  disabled: boolean;
  onPresetChange: (id: string) => void;
  onGraphChange: (graph: WorkflowGraph) => void;
  onTextChange: (text: string) => void;
};

function NodeIdField({ id, index, disabled, onCommit }: {
  id: string;
  index: number;
  disabled: boolean;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(id);
  useEffect(() => setDraft(id), [id]);

  const commit = () => {
    const next = draft.trim();
    if (!next || next === id) {
      setDraft(id);
      return;
    }
    onCommit(next);
  };

  return (
    <input
      className="wf-node-id"
      value={draft}
      disabled={disabled}
      spellCheck={false}
      aria-label={`Node ${index + 1} ID`}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.stopPropagation();
          setDraft(id);
        }
      }}
    />
  );
}

function ExecutionMap({ graph }: { graph: WorkflowGraph }) {
  const layers = graphLayers(graph);
  return (
    <div className="wf-stats" aria-label="Execution order">
      {layers.map((layer, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Icon name="chevron" size={12} />}
          <span className="tag" title={`Stage ${index + 1}: ${layer.join(", ")}`}>{layer.join(" · ")}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

export function WorkflowEditor(props: EditorProps) {
  const {
    graph, text, error, presets, selectedPresetId, participants, synthesizer,
    disabled, onPresetChange, onGraphChange, onTextChange,
  } = props;
  const templateRefs = useRef(new Map<string, HTMLTextAreaElement>());

  function insertPlaceholder(nodeId: string, token: string) {
    if (!graph) return;
    const node = graph.nodes.find(candidate => candidate.id === nodeId);
    const field = templateRefs.current.get(nodeId);
    if (!node) return;
    const at = field?.selectionStart ?? node.promptTemplate.length;
    const next = `${node.promptTemplate.slice(0, at)}${token}${node.promptTemplate.slice(field?.selectionEnd ?? at)}`;
    onGraphChange(updateNode(graph, nodeId, { promptTemplate: next }));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(at + token.length, at + token.length);
    });
  }

  const slots = requiredParticipants(graph);

  return (
    <section className="wf section" aria-label="Workflow graph">
      <div className="wf-head">
        <div>
          <span className="eyebrow">Workflow graph</span>
          <h4>{graph?.name ?? "Custom workflow"}</h4>
          <p>{graph?.description || presets.find(preset => preset.id === selectedPresetId)?.description
            || "Every node runs once. A node starts as soon as its own dependencies finish."}</p>
        </div>
        <label className="field">
          <span>Start from</span>
          <select className="control" value={selectedPresetId} disabled={disabled} onChange={event => onPresetChange(event.target.value)}>
            <option value="">Edited graph</option>
            {presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="banner" data-tone="warn"><Icon name="alert" size={14} className="banner-icon" /><p>{error}</p></div>}

      {graph && (
        <>
          <div className="wf-stats">
            <span className="tag">{graph.nodes.length} node{graph.nodes.length === 1 ? "" : "s"}</span>
            <span className="tag">{slots} participant slot{slots === 1 ? "" : "s"}</span>
            <span className="tag">output · {graph.outputNodeId || "none"}</span>
          </div>
          <ExecutionMap graph={graph} />

          <div className="section">
            {graph.nodes.map((node, index) => {
              const dependsOn = node.dependsOn ?? [];
              const isOutput = node.id === graph.outputNodeId;
              const assigned = node.model.type === "synthesizer"
                ? synthesizer
                : participants[node.model.index];

              return (
                <article className="wf-node" key={node.id} data-output={isOutput}>
                  <div className="wf-node-head">
                    <span className="num">{index + 1}</span>
                    <NodeIdField
                      id={node.id}
                      index={index}
                      disabled={disabled}
                      onCommit={next => onGraphChange(renameNode(graph, node.id, next))}
                    />
                    {assigned
                      ? <ModelIdentity model={assigned} />
                      : <span className="dep-empty">slot {node.model.type === "participant" ? node.model.index + 1 : "—"} unassigned</span>}
                    <div className="wf-node-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        aria-label={`Make ${node.id} the output node`}
                        aria-pressed={isOutput}
                        title={isOutput ? "This node's output is the final answer" : "Make this the final answer"}
                        disabled={disabled || isOutput}
                        onClick={() => onGraphChange(setOutputNode(graph, node.id))}
                      >
                        <Icon name="target" size={14} style={isOutput ? { color: "var(--accent)" } : undefined} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        aria-label={`Remove node ${node.id}`}
                        disabled={disabled || graph.nodes.length === 1}
                        onClick={() => onGraphChange(removeNode(graph, node.id))}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="wf-node-grid">
                    <label className="field">
                      <span>Step kind</span>
                      <select
                        className="control"
                        value={node.kind}
                        disabled={disabled}
                        onChange={event => onGraphChange(updateNode(graph, node.id, { kind: event.target.value as OrchestrationStepKind }))}
                      >
                        {workflowKinds.map(kind => <option key={kind} value={kind}>{stepKindLabel[kind] ?? kind}</option>)}
                      </select>
                    </label>
                    <label className="field">
                      <span>Runs on</span>
                      <select
                        className="control"
                        value={node.model.type === "synthesizer" ? "synthesizer" : `participant:${node.model.index}`}
                        disabled={disabled}
                        onChange={event => {
                          const value = event.target.value;
                          onGraphChange(updateNode(graph, node.id, {
                            model: value === "synthesizer"
                              ? { type: "synthesizer" }
                              : { type: "participant", index: Number(value.split(":")[1]) },
                          }));
                        }}
                      >
                        {Array.from({ length: Math.max(slots, participants.length, node.model.type === "participant" ? node.model.index + 1 : 0) + 1 })
                          .map((_, slot) => (
                            <option key={slot} value={`participant:${slot}`}>
                              Participant {slot + 1}{participants[slot] ? ` · ${participants[slot].label}` : ""}
                            </option>
                          ))}
                        <option value="synthesizer">Synthesizer{synthesizer ? ` · ${synthesizer.label}` : ""}</option>
                      </select>
                    </label>
                  </div>

                  <div className="field">
                    <span>Waits for</span>
                    <div className="wf-deps">
                      {graph.nodes.length === 1 && <span className="dep-empty">Nothing else to wait for yet.</span>}
                      {graph.nodes.filter(other => other.id !== node.id).map(other => {
                        const allowed = canDependOn(graph, node.id, other.id);
                        const on = dependsOn.includes(other.id);
                        return (
                          <button
                            type="button"
                            key={other.id}
                            className="dep-toggle"
                            aria-pressed={on}
                            disabled={disabled || (!on && !allowed)}
                            title={!on && !allowed ? `${other.id} runs after ${node.id}, so this would create a cycle` : undefined}
                            onClick={() => onGraphChange(toggleDependency(graph, node.id, other.id))}
                          >
                            {other.id}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="wf-template">
                    <span>Prompt template</span>
                    <textarea
                      ref={element => {
                        if (element) templateRefs.current.set(node.id, element);
                        else templateRefs.current.delete(node.id);
                      }}
                      value={node.promptTemplate}
                      disabled={disabled}
                      spellCheck={false}
                      aria-label={`Prompt template for ${node.id}`}
                      onChange={event => onGraphChange(updateNode(graph, node.id, { promptTemplate: event.target.value }))}
                    />
                    <div className="wf-inserts">
                      <span>Insert</span>
                      <button type="button" className="insert" disabled={disabled} onClick={() => insertPlaceholder(node.id, "{{prompt}}")}>{"{{prompt}}"}</button>
                      <button type="button" className="insert" disabled={disabled || dependsOn.length === 0} onClick={() => insertPlaceholder(node.id, "{{dependencies}}")}>{"{{dependencies}}"}</button>
                      {dependsOn.map(dependency => (
                        <button
                          key={dependency}
                          type="button"
                          className="insert"
                          disabled={disabled}
                          onClick={() => insertPlaceholder(node.id, `{{dep.${dependency}}}`)}
                        >
                          {`{{dep.${dependency}}}`}
                        </button>
                      ))}
                    </div>
                  </div>
                </article>
              );
            })}

            <div className="wf-stats">
              <button type="button" className="btn" disabled={disabled} onClick={() => onGraphChange(addNode(graph))}>
                <Icon name="plus" size={13} /> Add node
              </button>
              <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onGraphChange(emptyWorkflow())}>
                <Icon name="restart" size={13} /> Reset to a blank graph
              </button>
            </div>
          </div>
        </>
      )}

      <details className="disclosure wf-json">
        <summary>
          <Icon name="chevron" size={12} className="chevron" />
          Advanced · edit the graph as JSON
        </summary>
        <div className="disclosure-body">
          <textarea
            value={text}
            disabled={disabled}
            spellCheck={false}
            aria-label="Workflow graph JSON"
            aria-invalid={Boolean(error)}
            onChange={event => onTextChange(event.target.value)}
          />
          <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 11.5 }}>
            Templates support <code>{"{{prompt}}"}</code>, <code>{"{{dependencies}}"}</code> and declared{" "}
            <code>{"{{dep.nodeId}}"}</code> references. Interpolation is single-pass, so placeholder-like text inside a
            model's output stays literal.
          </p>
          <div className="wf-stats">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={disabled || !graph}
              onClick={() => graph && onTextChange(serializeWorkflow(graph))}
            >
              <Icon name="restart" size={13} /> Reformat
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}
