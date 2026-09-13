import { describe, expect, it } from "vitest";
import { formatDuration, formatWindow, highlight, previewLine, recencyBucket, relativeTime, searchTerms } from "./text";

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
