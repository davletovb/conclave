import React, { useEffect, useRef, useState } from "react";
import type { ConversationExportFormat, ConversationSummary, ProviderLimitSnapshot, ProviderStatus } from "@conclave/core";
import { formatWindow, recencyBucket, relativeTime, searchTerms } from "../lib/text";
import { Highlighted, Icon, Keys, Menu } from "./primitives";

type RailProps = {
  conversations: ConversationSummary[];
  activeId?: string;
  activeRunning: boolean;
  query: string;
  searching: boolean;
  onQueryChange: (value: string) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onExport: (id: string, format: ConversationExportFormat) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  providers: ProviderStatus[];
  providersLoading: boolean;
  providersError: string;
  limits: ProviderLimitSnapshot[];
  busy: boolean;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onShowShortcuts: () => void;
  onCollapse: () => void;
  onOpenPalette: () => void;
};

function runtimeName(status: ProviderStatus) {
  const plan = status.planType ? ` ${status.planType}` : "";
  if (status.id === "openai") return `ChatGPT${plan}`;
  if (status.id === "anthropic") return `Claude${plan}`;
  if (status.id === "xai") return `Grok${plan}`;
  if (status.id === "google") return `Gemini${plan}`;
  return status.label;
}

function QuotaStrip({ limits }: { limits: ProviderLimitSnapshot[] }) {
  const windows = limits.flatMap(snapshot => (snapshot.available
    ? [snapshot.primary, snapshot.secondary]
      .filter((window): window is NonNullable<typeof window> => Boolean(window))
      .map(window => ({ provider: snapshot.provider, window }))
    : []));
  if (windows.length === 0) return null;

  return (
    <div className="quota-strip">
      <span className="eyebrow">Subscription window</span>
      {windows.map(({ provider, window }, index) => (
        <div className="quota-row" key={`${provider}-${index}`}>
          <span>
            <span className="num">{provider} · {formatWindow(window.windowDurationMins)}</span>
            <span className="num">{window.usedPercent}%</span>
          </span>
          <span className="meter">
            <i
              style={{ width: `${Math.min(100, Math.max(2, window.usedPercent))}%` }}
              data-level={window.usedPercent >= 90 ? "critical" : window.usedPercent >= 70 ? "high" : undefined}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

function Thread({
  item,
  terms,
  active,
  running,
  onOpen,
  onRename,
  onDelete,
  onExport,
}: {
  item: ConversationSummary;
  terms: string[];
  active: boolean;
  running: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onExport: (format: ConversationExportFormat) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.title);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  function closeMenu() {
    setMenuOpen(false);
    setConfirming(false);
    triggerRef.current?.focus();
  }

  async function commitRename() {
    const next = draft.trim();
    setRenaming(false);
    if (!next || next === item.title) return;
    await onRename(next);
  }

  if (renaming) {
    return (
      <div className="thread thread-rename">
        <input
          ref={inputRef}
          value={draft}
          aria-label={`Rename ${item.title}`}
          onChange={event => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commitRename();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setDraft(item.title);
              setRenaming(false);
            }
          }}
        />
        <p className="thread-rename-hint">Enter saves · Esc cancels</p>
      </div>
    );
  }

  return (
    <div className="thread" data-active={active}>
      <button type="button" className="thread-open" onClick={onOpen} aria-current={active ? "true" : undefined}>
        <span className="thread-title"><Highlighted text={item.title} terms={terms} /></span>
        {item.snippet && <span className="thread-snippet"><Highlighted text={item.snippet} terms={terms} /></span>}
        <span className="thread-meta num">
          {running ? <span className="thread-live">running now</span> : relativeTime(item.updatedAt)}
          {" · "}
          {item.messageCount} message{item.messageCount === 1 ? "" : "s"}
        </span>
      </button>

      <button
        ref={triggerRef}
        type="button"
        className="thread-menu-btn"
        aria-label={`Actions for ${item.title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(open => !open)}
      >
        <Icon name="more" size={14} />
      </button>

      {menuOpen && (
        <Menu label={`${item.title} actions`} onClose={closeMenu}>
          {confirming ? (
            <>
              <p style={{ margin: "4px 8px 8px", fontSize: 11.5, lineHeight: 1.45, color: "var(--ink-2)" }}>
                Delete this conversation and its run history? This cannot be undone.
              </p>
              <button
                type="button"
                role="menuitem"
                className="destructive"
                onClick={async () => {
                  setMenuOpen(false);
                  setConfirming(false);
                  await onDelete();
                }}
              >
                <Icon name="trash" size={14} /> Delete permanently
              </button>
              <button type="button" role="menuitem" onClick={() => setConfirming(false)}>
                <Icon name="close" size={14} /> Keep it
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setDraft(item.title);
                  setRenaming(true);
                }}
              >
                <Icon name="pencil" size={14} /> Rename
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onExport("markdown"); }}>
                <Icon name="download" size={14} /> Export Markdown
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onExport("json"); }}>
                <Icon name="download" size={14} /> Export JSON
              </button>
              <hr />
              <button
                type="button"
                role="menuitem"
                className="destructive"
                disabled={running}
                title={running ? "Stop this conversation's run before deleting it" : undefined}
                onClick={() => setConfirming(true)}
              >
                <Icon name="trash" size={14} /> Delete…
              </button>
            </>
          )}
        </Menu>
      )}
    </div>
  );
}

export function Rail(props: RailProps) {
  const {
    conversations, activeId, activeRunning, query, searching, onQueryChange, onOpen, onNew,
    onRename, onDelete, onExport, searchRef, providers, providersLoading, providersError,
    limits, busy, theme, onToggleTheme, onShowShortcuts, onCollapse, onOpenPalette,
  } = props;

  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const terms = searchTerms(query);
  const subscription = providers.filter(provider => provider.id !== "mock");
  const connected = subscription.filter(provider => provider.connected);
  const runtimeLabel = providersLoading
    ? "Checking runtimes…"
    : connected.length > 0
      ? `${connected.map(runtimeName).join(" · ")} connected`
      : providers.length === 0
        ? "Runtime status unavailable"
        : "Subscription runtimes offline · mocks active";
  const runtimeDetail = providersLoading
    ? "Checking local subscription runtimes…"
    : providersError || subscription
      .map(provider => `${runtimeName(provider)}: ${provider.message ?? (provider.connected ? "connected" : "not connected")}`)
      .join("\n");

  const groups: Array<{ label: string; items: ConversationSummary[] }> = [];
  for (const item of conversations) {
    const label = terms.length > 0 ? "Results" : recencyBucket(item.updatedAt);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }

  return (
    <nav className="rail" aria-label="Conversations">
      <div className="rail-head">
        <span className="mark" aria-hidden="true">C</span>
        <div>
          <h1>Conclave</h1>
          <p>Many models. One room.</p>
        </div>
        <button type="button" className="btn btn-ghost btn-icon rail-toggle" onClick={onCollapse} aria-label="Hide conversation rail">
          <Icon name="panel" />
        </button>
      </div>

      <div className="rail-actions">
        <button type="button" className="btn btn-block" onClick={onNew}>
          <Icon name="plus" size={14} /> New conversation <Keys keys={["N"]} />
        </button>
        <button type="button" className="btn btn-block" onClick={onOpenPalette}>
          <Icon name="command" size={14} /> Commands <Keys keys={["Mod", "K"]} />
        </button>
      </div>

      <div className="rail-search">
        <span className="search-glyph"><Icon name="search" size={14} /></span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder="Search conversations"
          aria-label="Search conversations by title or message text"
          onChange={event => onQueryChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Escape" && query) {
              event.stopPropagation();
              onQueryChange("");
            }
          }}
        />
        {query && (
          <button type="button" className="search-clear" onClick={() => onQueryChange("")} aria-label="Clear search">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      <div className="rail-list">
        <p aria-live="polite" className="sr-only">
          {query ? `${conversations.length} conversation${conversations.length === 1 ? "" : "s"} match ${query}` : ""}
        </p>
        {conversations.length === 0 ? (
          <p className="rail-empty">
            {searching ? "Searching…" : query ? `Nothing matches “${query}”.` : "No conversations yet. Your first run starts one."}
          </p>
        ) : groups.map(group => (
          <section key={group.label}>
            <div className="rail-group-label eyebrow">{group.label}</div>
            {group.items.map(item => (
              <Thread
                key={item.id}
                item={item}
                terms={terms}
                active={item.id === activeId}
                running={item.id === activeId && activeRunning}
                onOpen={() => onOpen(item.id)}
                onRename={title => onRename(item.id, title)}
                onDelete={() => onDelete(item.id)}
                onExport={format => onExport(item.id, format)}
              />
            ))}
          </section>
        ))}
      </div>

      <div className="rail-foot">
        <QuotaStrip limits={limits} />
        <button
          type="button"
          className="runtime"
          aria-expanded={runtimeOpen}
          onClick={() => setRuntimeOpen(open => !open)}
        >
          <span className="beacon" data-state={busy ? "busy" : connected.length > 0 ? "ready" : "idle"} />
          <span>{runtimeLabel}</span>
        </button>
        {runtimeOpen && (
          <dl className="kv">
            {providersError && <dd style={{ gridColumn: "1 / -1", textAlign: "left", color: "var(--danger)" }}>{providersError}</dd>}
            {subscription.map(provider => (
              <React.Fragment key={provider.id}>
                <dt>{runtimeName(provider)}</dt>
                <dd title={provider.message}>{provider.connected ? "connected" : provider.available ? "signed out" : "not installed"}</dd>
              </React.Fragment>
            ))}
            {subscription.length === 0 && !providersError && <dd style={{ gridColumn: "1 / -1" }}>{runtimeDetail}</dd>}
          </dl>
        )}
        <div className="rail-foot-row">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onToggleTheme}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onShowShortcuts} aria-label="Keyboard shortcuts">
            <Icon name="keyboard" />
          </button>
        </div>
      </div>
    </nav>
  );
}
