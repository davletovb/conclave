/**
 * Keyboard model for the whole app.
 *
 * Two tiers, so nothing collides with typing or with the browser:
 * · modified chords (Mod+…) stay live even inside the composer
 * · single letters only fire when the user is not typing into a field
 */

export type ShortcutId =
  | "palette"
  | "submit"
  | "stop"
  | "new-conversation"
  | "focus-composer"
  | "configure"
  | "details"
  | "expand-all"
  | "collapse-all"
  | "toggle-rail"
  | "toggle-theme"
  | "help"
  | "dismiss";

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutContext {
  /** Focus is inside a text field, so bare letters belong to the user. */
  typing: boolean;
  /** A dialog, drawer or menu is on top and owns Escape. */
  layered?: boolean;
}

export interface ShortcutHint {
  id: ShortcutId;
  keys: string[];
  label: string;
  group: "Run" | "Navigate" | "View";
}

/** Documented bindings. The help dialog and command palette both read this. */
export const shortcutHints: ShortcutHint[] = [
  { id: "palette", keys: ["Mod", "K"], label: "Command palette and conversation search", group: "Navigate" },
  { id: "submit", keys: ["Mod", "Enter"], label: "Convene the council", group: "Run" },
  { id: "stop", keys: ["Mod", "."], label: "Stop the active run", group: "Run" },
  { id: "focus-composer", keys: ["/"], label: "Jump to the prompt", group: "Run" },
  { id: "configure", keys: ["C"], label: "Show or hide run configuration", group: "Run" },
  { id: "details", keys: ["D"], label: "Show or hide run details", group: "View" },
  { id: "expand-all", keys: ["E"], label: "Expand every council step", group: "View" },
  { id: "collapse-all", keys: ["Shift", "E"], label: "Collapse every council step", group: "View" },
  { id: "new-conversation", keys: ["N"], label: "Start a new conversation", group: "Navigate" },
  { id: "toggle-rail", keys: ["S"], label: "Show or hide the conversation rail", group: "Navigate" },
  { id: "toggle-theme", keys: ["T"], label: "Switch theme", group: "View" },
  { id: "help", keys: ["?"], label: "Keyboard shortcuts", group: "View" },
  { id: "dismiss", keys: ["Esc"], label: "Close the top layer", group: "Navigate" },
];

export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}

export function matchShortcut(event: KeyEventLike, context: ShortcutContext): ShortcutId | null {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key;

  if (key === "Escape") return "dismiss";

  if (mod && !event.altKey) {
    if (key === "k" || key === "K") return "palette";
    if (key === "Enter") return "submit";
    if (key === ".") return "stop";
    return null;
  }

  // Everything below is a bare key, so it must not steal a keystroke from a
  // text field or from a layer that has its own key handling.
  if (mod || event.altKey || context.typing || context.layered) return null;

  if (key === "/") return "focus-composer";
  if (key === "?") return "help";
  if (event.shiftKey) return key === "E" ? "collapse-all" : null;
  if (key === "c") return "configure";
  if (key === "d") return "details";
  if (key === "e") return "expand-all";
  if (key === "n") return "new-conversation";
  if (key === "s") return "toggle-rail";
  if (key === "t") return "toggle-theme";
  return null;
}

/** "Mod" renders as ⌘ on Apple platforms and Ctrl everywhere else. */
export function renderKey(key: string, apple: boolean) {
  if (key === "Mod") return apple ? "⌘" : "Ctrl";
  if (key === "Shift") return apple ? "⇧" : "Shift";
  if (key === "Enter") return apple ? "↩" : "Enter";
  return key;
}
