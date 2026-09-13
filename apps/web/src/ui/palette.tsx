import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationSummary, OrchestrationMode } from "@conclave/core";
import { relativeTime, searchTerms } from "../lib/text";
import { Highlighted, Icon, Keys, Layer, type ModeMeta } from "./primitives";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: string;
  keys?: string[];
  run: () => void;
};

/**
 * One entry point for search and for every action that has a keyboard binding,
 * so nothing is discoverable only by memorising a shortcut.
 */
export function CommandPalette({
  conversations,
  modes,
  mode,
  commands,
  onSearch,
  onOpenConversation,
  onSelectMode,
  onClose,
}: {
  conversations: ConversationSummary[];
  modes: ModeMeta[];
  mode: OrchestrationMode;
  commands: Command[];
  onSearch: (query: string, signal: AbortSignal) => Promise<ConversationSummary[]>;
  onOpenConversation: (id: string) => void;
  onSelectMode: (mode: OrchestrationMode) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<ConversationSummary[] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const terms = searchTerms(query);
  const matches = (text: string) => terms.every(term => text.toLowerCase().includes(term));

  // Conversation search runs on the server so the palette reaches message
  // bodies, not only the titles already loaded in the rail.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      try {
        setHits(await onSearch(query, controller.signal));
      } catch {
        // Keep the last good result set rather than emptying the palette.
      }
    }, 140);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [query, onSearch]);

  const threads = hits ?? conversations;

  const items = useMemo(() => {
    const entries: Array<{ key: string; group: string; node: React.ReactNode; run: () => void; searchText: string }> = [];

    for (const command of commands.filter(command => matches(`${command.label} ${command.hint ?? ""}`))) {
      entries.push({
        key: `command:${command.id}`,
        group: command.group,
        searchText: command.label,
        run: command.run,
        node: (
          <>
            <Icon name={command.icon} size={14} />
            <span className="palette-label">
              <b><Highlighted text={command.label} terms={terms} /></b>
              {command.hint && <span>{command.hint}</span>}
            </span>
            {command.keys && <Keys keys={command.keys} />}
          </>
        ),
      });
    }

    for (const meta of modes.filter(meta => matches(`${meta.label} ${meta.description} mode`))) {
      entries.push({
        key: `mode:${meta.id}`,
        group: "Switch pattern",
        searchText: meta.label,
        run: () => onSelectMode(meta.id),
        node: (
          <>
            <Icon name="target" size={14} />
            <span className="palette-label">
              <b><Highlighted text={meta.label} terms={terms} /></b>
              <span>{meta.description}</span>
            </span>
            {meta.id === mode && <span className="pill" data-status="completed">current</span>}
          </>
        ),
      });
    }

    for (const conversation of threads.slice(0, 40)) {
      entries.push({
        key: `conversation:${conversation.id}`,
        group: "Conversations",
        searchText: conversation.title,
        run: () => onOpenConversation(conversation.id),
        node: (
          <>
            <Icon name="search" size={14} />
            <span className="palette-label">
              <b><Highlighted text={conversation.title} terms={terms} /></b>
              <span>
                {conversation.snippet
                  ? <Highlighted text={conversation.snippet} terms={terms} />
                  : `${relativeTime(conversation.updatedAt)} · ${conversation.messageCount} messages`}
              </span>
            </span>
          </>
        ),
      });
    }

    // Group by label rather than by adjacency: commands of one group can be
    // produced out of order, and two sections with the same name would collide.
    const grouped: Array<{ label: string; entries: typeof entries }> = [];
    for (const entry of entries) {
      const group = grouped.find(candidate => candidate.label === entry.group);
      if (group) group.entries.push(entry);
      else grouped.push({ label: entry.group, entries: [entry] });
    }
    // Keyboard selection indexes the rendered order, so flatten after grouping.
    return { groups: grouped, ordered: grouped.flatMap(group => group.entries) };
  }, [commands, threads, modes, mode, query]);

  const { groups, ordered } = items;

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      setActive(index => (ordered.length === 0 ? 0 : (index + 1) % ordered.length));
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setActive(index => (ordered.length === 0 ? 0 : (index - 1 + ordered.length) % ordered.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = ordered[active];
      if (item) {
        onClose();
        item.run();
      }
    }
  }

  let cursor = -1;

  return (
    <Layer variant="modal" onClose={onClose} initialFocus={inputRef} labelledBy="palette-label">
      <div className="modal-head" style={{ padding: 0, border: 0 }}>
        <h2 id="palette-label" className="sr-only">Command palette</h2>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="Search conversations, switch pattern, run a command…"
          aria-label="Search conversations or run a command"
          aria-controls="palette-results"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="modal-body" ref={listRef} id="palette-results" role="listbox" aria-label="Results">
        {ordered.length === 0 && <p className="palette-empty">Nothing matches “{query}”.</p>}
        {groups.map(group => (
          <div className="palette-group" key={group.label}>
            <span className="eyebrow">{group.label}</span>
            {group.entries.map(entry => {
              cursor += 1;
              const index = cursor;
              return (
                <button
                  type="button"
                  key={entry.key}
                  role="option"
                  aria-selected={index === active}
                  className="palette-item"
                  data-active={index === active}
                  tabIndex={-1}
                  onMouseMove={() => setActive(index)}
                  onClick={() => { onClose(); entry.run(); }}
                >
                  {entry.node}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="palette-foot">
        <span>↑↓ move</span>
        <span>↵ open</span>
        <span>esc close</span>
      </div>
    </Layer>
  );
}
