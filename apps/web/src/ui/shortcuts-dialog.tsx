import React from "react";
import { shortcutHints } from "../lib/shortcuts";
import { Keys, Layer } from "./primitives";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const groups = ["Run", "Navigate", "View"] as const;

  return (
    <Layer variant="modal" title="Keyboard shortcuts" onClose={onClose}>
      <div className="modal-body">
        {groups.map(group => (
          <section key={group} className="palette-group">
            <span className="eyebrow">{group}</span>
            <div className="shortcut-grid">
              {shortcutHints.filter(hint => hint.group === group).map(hint => (
                <div className="shortcut-row" key={hint.id}>
                  <span>{hint.label}</span>
                  <span className="keys"><Keys keys={hint.keys} /></span>
                </div>
              ))}
            </div>
          </section>
        ))}
        <section className="palette-group">
          <span className="eyebrow">In the prompt</span>
          <div className="shortcut-grid">
            <div className="shortcut-row">
              <span>Send the prompt</span>
              <span className="keys"><Keys keys={["Enter"]} /></span>
            </div>
            <div className="shortcut-row">
              <span>New line</span>
              <span className="keys"><Keys keys={["Shift", "Enter"]} /></span>
            </div>
          </div>
        </section>
      </div>
    </Layer>
  );
}
