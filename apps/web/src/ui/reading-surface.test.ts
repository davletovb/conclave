import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The reading column is a stack of single-column grids, and a grid track sized
 * `auto` is floored at its items' min-content width. Model output routinely
 * contains something unbreakable — a long import line, a URL, a JSON blob in a
 * code block — so without an explicit shrinkable track the track grows past the
 * column's own box and *stretches every sibling with it*: the answer, the
 * prompt bubble and the Copy button all slide right while the composer, which
 * is outside the column, stays where it was. The column stops looking centred.
 *
 * jsdom has no layout, so it cannot size a grid track; the invariant is a
 * stylesheet property, and this is where it can be checked.
 */
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

/** The declarations of the first rule whose selector list starts with `selector`. */
function rule(selector: string): string {
  const at = css.search(new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s,{]`, "m"));
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
}

/** Every grid on the path from the scroll surface down to rendered markdown. */
const contentGrids = [".column", ".turns", ".turn", ".answer", ".council"];

describe("reading column", () => {
  it.each(contentGrids)("gives %s a track that can shrink below its content", (selector) => {
    const declarations = rule(selector);
    expect(declarations).toMatch(/display:\s*grid/);
    // `minmax(0, 1fr)` — not `1fr`, which is also floored at min-content.
    expect(declarations).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("lets a code block scroll inside itself rather than push the column", () => {
    // The shrinkable track is only the right answer because the overflow has
    // somewhere to go: without this the long line would simply be cut off.
    expect(rule(".markdown pre")).toMatch(/overflow-x:\s*auto/);
    expect(rule(".markdown-table-wrap")).toMatch(/overflow-x:\s*auto/);
  });

  it("keeps the column and the composer on the same measure", () => {
    // They are siblings under .workspace, so equal width and `margin: 0 auto`
    // is what puts them on one centre line. The report that started this was
    // the two drifting apart.
    for (const selector of [".column", ".composer"]) {
      expect(rule(selector)).toMatch(/width:\s*min\(var\(--measure\),\s*100%\)/);
      expect(rule(selector)).toMatch(/margin:\s*0 auto/);
    }
  });
});
