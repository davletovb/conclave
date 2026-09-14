import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Everything that is `position: fixed` shares one stacking context, so the only
 * thing keeping a dialog above navigation is the numbers. On a narrow viewport
 * the rail is fixed too, and a dialog opened *from* the rail — Commands, or the
 * keyboard-shortcuts icon — leaves the rail open behind it. When the rail won
 * that comparison the layer was invisible and unclickable while `Layer` had
 * already moved focus into it: focus in content the reader cannot see.
 *
 * jsdom has no layout and no `elementFromPoint`, so it cannot observe stacking
 * at all. The invariant lives in the stylesheet, so assert it there.
 */
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

/** Value of a `--z-*` custom property declared on `:root`. */
function token(name: string): number {
  const match = css.match(new RegExp(`--${name}:\\s*(\\d+);`));
  expect(match, `--${name} is not declared`).not.toBeNull();
  return Number(match![1]);
}

/** The `z-index` each selector's own rule sets, as written. */
function zIndexOf(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const rule = css.slice(at, css.indexOf("}", at));
  const match = rule.match(/z-index:\s*([^;]+);/);
  expect(match, `${selector} declares no z-index`).not.toBeNull();
  return match![1].trim();
}

describe("fixed-layer stacking order", () => {
  it("puts dialogs and drawers above the rail and its scrim", () => {
    const railScrim = token("z-rail-scrim");
    const rail = token("z-rail");
    const overlay = token("z-overlay");
    const layer = token("z-layer");

    expect(railScrim).toBeLessThan(rail);
    // the two that matter: a layer opened while the mobile rail is up
    expect(overlay).toBeGreaterThan(rail);
    expect(layer).toBeGreaterThan(overlay);
    // and the skip link stays reachable above all of it
    expect(token("z-skip-link")).toBeGreaterThan(layer);
  });

  it("drives every fixed layer from those tokens, not from a literal", () => {
    // Without this the ordering above is a statement about five unused numbers.
    expect(zIndexOf(".overlay {")).toBe("var(--z-overlay)");
    expect(zIndexOf(".modal {")).toBe("var(--z-layer)");
    expect(zIndexOf(".drawer {")).toBe("var(--z-layer)");
    expect(zIndexOf(".skip-link {")).toBe("var(--z-skip-link)");
    expect(zIndexOf(".rail {\n    position: fixed;")).toBe("var(--z-rail)");
    expect(zIndexOf('.shell[data-rail="open"] .scrim')).toBe("var(--z-rail-scrim)");
  });
});
