import { describe, expect, it } from "vitest";
import { type KeyEventLike, matchShortcut, renderKey, shortcutHints } from "./shortcuts";

function press(key: string, modifiers: Partial<KeyEventLike> = {}): KeyEventLike {
  return { key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers };
}

describe("matchShortcut", () => {
  it("accepts either platform's modifier for chords", () => {
    expect(matchShortcut(press("k", { metaKey: true }), { typing: false })).toBe("palette");
    expect(matchShortcut(press("k", { ctrlKey: true }), { typing: false })).toBe("palette");
    expect(matchShortcut(press("K", { metaKey: true }), { typing: false })).toBe("palette");
  });

  it("keeps chords alive while the user is typing", () => {
    expect(matchShortcut(press("Enter", { metaKey: true }), { typing: true })).toBe("submit");
    expect(matchShortcut(press(".", { ctrlKey: true }), { typing: true })).toBe("stop");
    expect(matchShortcut(press("k", { metaKey: true }), { typing: true })).toBe("palette");
  });

  it("never steals a bare key from a text field", () => {
    for (const key of ["c", "d", "e", "n", "s", "t", "/", "?"]) {
      expect(matchShortcut(press(key), { typing: true })).toBeNull();
    }
    expect(matchShortcut(press("n"), { typing: false })).toBe("new-conversation");
  });

  it("lets an open layer keep its own bare keys but still close on Escape", () => {
    expect(matchShortcut(press("d"), { typing: false, layered: true })).toBeNull();
    expect(matchShortcut(press("Escape"), { typing: false, layered: true })).toBe("dismiss");
    expect(matchShortcut(press("Escape"), { typing: true })).toBe("dismiss");
  });

  it("separates expand from collapse by Shift", () => {
    expect(matchShortcut(press("e"), { typing: false })).toBe("expand-all");
    expect(matchShortcut(press("E", { shiftKey: true }), { typing: false })).toBe("collapse-all");
    expect(matchShortcut(press("D", { shiftKey: true }), { typing: false })).toBeNull();
  });

  it("ignores unbound and Alt-modified keys", () => {
    expect(matchShortcut(press("z"), { typing: false })).toBeNull();
    expect(matchShortcut(press("e", { altKey: true }), { typing: false })).toBeNull();
    expect(matchShortcut(press("k", { metaKey: true, altKey: true }), { typing: false })).toBeNull();
    expect(matchShortcut(press("j", { metaKey: true }), { typing: false })).toBeNull();
  });

  it("documents every binding it can produce", () => {
    const documented = new Set(shortcutHints.map(hint => hint.id));
    const produced = new Set(
      [
        press("k", { metaKey: true }), press("Enter", { metaKey: true }), press(".", { metaKey: true }),
        press("/"), press("c"), press("d"), press("e"), press("E", { shiftKey: true }),
        press("n"), press("s"), press("t"), press("?"), press("Escape"),
      ].map(event => matchShortcut(event, { typing: false })),
    );
    expect([...produced].every(id => id !== null && documented.has(id))).toBe(true);
    expect(produced.size).toBe(documented.size);
  });
});

describe("renderKey", () => {
  it("uses platform glyphs", () => {
    expect(renderKey("Mod", true)).toBe("⌘");
    expect(renderKey("Mod", false)).toBe("Ctrl");
    expect(renderKey("Shift", true)).toBe("⇧");
    expect(renderKey("E", false)).toBe("E");
  });
});
