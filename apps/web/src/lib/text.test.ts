import React from "react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../ui/markdown";
import { collapsePrompt, collapseStepOutput, formatDuration, formatWindow, highlight, previewLine, recencyBucket, relativeTime, searchTerms } from "./text";

describe("searchTerms", () => {
  it("keeps quoted phrases whole and drops empty input", () => {
    expect(searchTerms('red "team pass" grok')).toEqual(["red", "team pass", "grok"]);
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("highlight", () => {
  it("marks each hit and leaves the rest intact", () => {
    expect(highlight("Grok and GPT debate", ["grok"])).toEqual([
      { text: "Grok", match: true },
      { text: " and GPT debate", match: false },
    ]);
  });

  it("merges overlapping and repeated hits", () => {
    expect(highlight("abcabc", ["abc", "bca"])).toEqual([{ text: "abcabc", match: true }]);
    expect(highlight("aa", ["a"])).toEqual([{ text: "aa", match: true }]);
  });

  it("returns one plain segment when nothing matches", () => {
    expect(highlight("nothing", ["zzz"])).toEqual([{ text: "nothing", match: false }]);
    expect(highlight("nothing", [])).toEqual([{ text: "nothing", match: false }]);
    expect(highlight("", ["a"])).toEqual([{ text: "", match: false }]);
  });
});

describe("previewLine", () => {
  it("shows the last meaningful line without markdown noise", () => {
    expect(previewLine("## Heading\n\n- point one\n\n")).toBe("point one");
    expect(previewLine("")).toBe("");
  });

  it("truncates long lines", () => {
    expect(previewLine("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
  });
});

describe("formatting", () => {
  it("scales durations by magnitude", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("labels rate-limit windows in their natural unit", () => {
    expect(formatWindow(60)).toBe("1h");
    expect(formatWindow(1440)).toBe("1d");
    expect(formatWindow(10_080)).toBe("1w");
    expect(formatWindow(45)).toBe("45m");
    expect(formatWindow(undefined)).toBe("window");
  });

  it("describes recency in human terms", () => {
    const now = Date.parse("2026-03-10T12:00:00.000Z");
    expect(relativeTime("2026-03-10T11:59:40.000Z", now)).toBe("just now");
    expect(relativeTime("2026-03-10T11:30:00.000Z", now)).toBe("30m ago");
    expect(relativeTime("2026-03-10T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-03-09T09:00:00.000Z", now)).toBe("yesterday");
    expect(relativeTime("not-a-date", now)).toBe("");

    expect(recencyBucket("2026-03-10T08:00:00.000Z", now)).toBe("Today");
    expect(recencyBucket("2026-03-09T08:00:00.000Z", now)).toBe("Yesterday");
    expect(recencyBucket("2026-03-06T08:00:00.000Z", now)).toBe("This week");
    expect(recencyBucket("2026-02-20T08:00:00.000Z", now)).toBe("This month");
    expect(recencyBucket("2025-11-01T08:00:00.000Z", now)).toBe("Earlier");
  });
});

describe("collapsePrompt", () => {
  it("leaves a short prompt whole", () => {
    expect(collapsePrompt("What is the best council system?")).toBeUndefined();
    expect(collapsePrompt("a\nb\nc\nd\ne\nf")).toBeUndefined();
  });

  it("shortens a prompt that is too many lines or too long", () => {
    const many = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const collapsed = collapsePrompt(many)!;
    expect(collapsed.split("\n")).toHaveLength(6);
    expect(collapsed.endsWith("…")).toBe(true);
    expect(collapsed).not.toContain("line 6");

    const wide = collapsePrompt("x".repeat(2000))!;
    expect(wide.length).toBeLessThan(400);
    expect(wide.endsWith("…")).toBe(true);
  });

  it("truncates rather than hiding, so nothing stays behind the fold", () => {
    // A clipped element keeps its contents in the DOM, where a link would still
    // take focus. The excerpt must not contain the part it drops.
    const withLink = `intro\nsecond\nthird\nfourth\nfifth\nsixth\n[hidden](https://example.com)`;
    const collapsed = collapsePrompt(withLink)!;
    expect(collapsed).not.toContain("example.com");
    expect(collapsed).toContain("sixth");
  });
});

describe("collapseStepOutput", () => {
  it("leaves an ordinary answer whole", () => {
    expect(collapseStepOutput("A short verdict from one model.")).toBeUndefined();
    expect(collapseStepOutput(Array.from({ length: 40 }, () => "short line").join("\n"))).toBeUndefined();
  });

  it("shortens an output that is too many lines or too long", () => {
    const many = Array.from({ length: 90 }, (_, index) => `point ${index}`).join("\n");
    const collapsed = collapseStepOutput(many)!;
    expect(collapsed.split("\n")).toHaveLength(40);
    expect(collapsed.endsWith("…")).toBe(true);
    expect(collapsed).not.toContain("point 40");

    const wide = collapseStepOutput("x".repeat(9000))!;
    expect(wide.length).toBeLessThan(1440);
    expect(wide.endsWith("…")).toBe(true);
  });

  it("truncates rather than hiding, so nothing stays behind the fold", () => {
    // The step body used to clamp with `overflow: hidden`, which kept the whole
    // answer in the DOM: a link past the fold still took focus, and focusing it
    // scrolled a box the reader had no way to scroll back.
    const long = [...Array.from({ length: 40 }, (_, index) => `point ${index}`), "[buried](https://example.com)"].join("\n");
    const collapsed = collapseStepOutput(long)!;
    expect(collapsed).not.toContain("example.com");
    expect(collapsed).toContain("point 39");
  });
});

describe("collapsed excerpts and code fences", () => {
  // Backtick parity is not the invariant: the renderer closes a fence only on a
  // line that is nothing but ```, so an ellipsis glued to that line leaves the
  // fence open. Assert through the renderer's own rules instead.
  const collapsers = [
    ["collapsePrompt", collapsePrompt, 6] as const,
    ["collapseStepOutput", collapseStepOutput, 40] as const,
  ];

  for (const [name, collapse, kept] of collapsers) {
    it(`leaves no fence open in a ${name} excerpt, as the renderer parses it`, () => {
      const filler = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`);
      const cases = [
        // the line cut lands inside an open fence
        [...filler(kept - 5), `${FENCE}js`, "const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;", FENCE].join("\n"),
        // the last kept line is itself the closer, which must stay a closer
        [...filler(kept - 3), `${FENCE}js`, "code here", FENCE, "trailing"].join("\n"),
        // the character cut lands inside an open fence
        [`${FENCE}js`, `const a = "${"x".repeat(2000)}";`, FENCE].join("\n"),
        // no fences at all
        filler(kept * 2).join("\n"),
      ];

      for (const input of cases) {
        const collapsed = collapse(input);
        expect(collapsed).toBeDefined();
        expect(fenceLeftOpen(collapsed!)).toBe(false);
        // and the renderer agrees: whatever it produced, no code block swallowed
        // the ellipsis that marks the excerpt.
        expect(renderedText(collapsed!).trimEnd().endsWith("…")).toBe(true);
      }
    });
  }
});

const FENCE = "```";

/** The renderer's fence state machine, mirrored from ui/markdown.tsx. */
function fenceLeftOpen(text: string) {
  let open = false;
  for (const line of text.split("\n")) {
    if (open) open = !/^\s*```\s*$/.test(line);
    else if (/^\s*```([^`]*)$/.test(line)) open = true;
  }
  return open;
}

/** Visible text of the excerpt once Markdown has actually rendered it. */
function renderedText(content: string): string {
  const walk = (node: React.ReactNode): string => {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(walk).join("");
    if (React.isValidElement(node)) return walk((node.props as { children?: React.ReactNode }).children);
    return "";
  };
  return walk(Markdown({ content }));
}
