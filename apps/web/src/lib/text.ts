/** Small presentation helpers shared by the rail, the palette and telemetry. */

export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim().toLowerCase();
    if (term) terms.push(term);
    if (terms.length === 8) break;
  }
  return terms;
}

export type Segment = { text: string; match: boolean };

/** Split text into plain and matching segments so hits can be marked up. */
export function highlight(text: string, terms: string[]): Segment[] {
  if (terms.length === 0 || !text) return [{ text, match: false }];
  const haystack = text.toLowerCase();
  const ranges: Array<[number, number]> = [];

  for (const term of terms) {
    let from = 0;
    while (from <= haystack.length - term.length) {
      const at = haystack.indexOf(term, from);
      if (at < 0) break;
      ranges.push([at, at + term.length]);
      from = at + term.length;
    }
  }
  if (ranges.length === 0) return [{ text, match: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

/** Last meaningful line of a streaming step, for the collapsed preview. */
export function previewLine(content: string, limit = 160) {
  const line = content
    .split("\n")
    .map(part => part.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return "";
  const clean = line.replace(/^#{1,6}\s*/, "").replace(/^[-*+]\s+/, "").replace(/\s+/g, " ");
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export function formatDuration(ms?: number) {
  if (ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function formatWindow(minutes?: number) {
  if (!minutes) return "window";
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function relativeTime(iso: string, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 172_800) return "yesterday";
  if (seconds < 604_800) return `${Math.round(seconds / 86_400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Coarse buckets so the rail can group a long history by recency. */
export function recencyBucket(iso: string, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Earlier";
  const days = (now - then) / 86_400_000;
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return "This week";
  if (days < 30) return "This month";
  return "Earlier";
}

/**
 * An excerpt for a collapsed block of markdown, or undefined when it is already
 * short enough to show whole. The result is real text rather than a visual
 * clip: clipped content stays in the DOM behind the fold, where a link still
 * takes focus and focusing it scrolls a box the reader cannot scroll back.
 */
export function collapseMarkdown(content: string, limits: { lines: number; chars: number }) {
  const lines = content.split("\n");
  if (lines.length <= limits.lines && content.length <= limits.chars) return undefined;

  const clipped = lines.slice(0, limits.lines).join("\n").slice(0, limits.chars).trimEnd();
  const closed = fenceLeftOpen(clipped) ? `${clipped}\n${FENCE}` : clipped;

  // The renderer closes a fence only on a line that is nothing but ```, so the
  // ellipsis has to stay off any fence line: glued on, it stops the line being
  // a closer and either leaves the fence open or reopens one that was closed.
  const lastLine = closed.split("\n").at(-1) ?? "";
  return FENCE_LINE.test(lastLine) ? `${closed}\n…` : `${closed}…`;
}

/** A pasted prompt, shortened so it cannot bury the answer it belongs to. */
export function collapsePrompt(content: string) {
  return collapseMarkdown(content, { lines: 6, chars: 360 });
}

/** One model's output, shortened so a verbose step cannot bury the council. */
export function collapseStepOutput(content: string) {
  return collapseMarkdown(content, { lines: 40, chars: 1400 });
}

const FENCE = "```";
/** Any line the renderer could treat as a fence marker. */
const FENCE_LINE = /^\s*```/;
/** What the renderer opens a fence on, and what it closes one on. */
const FENCE_OPEN = /^\s*```([^`]*)$/;
const FENCE_CLOSE = /^\s*```\s*$/;

/**
 * Whether an excerpt ends inside a code fence, by the same rules the renderer
 * uses. Counting backticks is not the same question: a closer is only a closer
 * on a line of its own.
 */
function fenceLeftOpen(text: string) {
  let open = false;
  for (const line of text.split("\n")) {
    if (open) open = !FENCE_CLOSE.test(line);
    else if (FENCE_OPEN.test(line)) open = true;
  }
  return open;
}
