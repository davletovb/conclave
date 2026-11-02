import React from "react";
import type { SourceCitation } from "@conclave/core";

/** Treat provider output and recovered run records as untrusted, even after normalization. */
export function safeSources(sources: readonly SourceCitation[] = []): SourceCitation[] {
  const seen = new Set<string>();
  const links: SourceCitation[] = [];
  for (const source of sources) {
    if (!source || typeof source.url !== "string") continue;
    try {
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol) || seen.has(url.href)) continue;
      seen.add(url.href);
      links.push({ url: url.href, title: typeof source.title === "string" ? source.title.slice(0, 250) : undefined });
    } catch { /* Invalid URL; do not make it a clickable link. */ }
    if (links.length >= 24) break;
  }
  return links;
}

/** Always visible with the answer / step, including after reopening a persisted run. */
export function SourceLinks({ sources }: { sources?: readonly SourceCitation[] }) {
  const links = safeSources(sources);
  if (links.length === 0) return null;
  return (
    <section className="source-links" aria-label="Web sources">
      <span className="eyebrow">Web sources · {links.length}</span>
      <ol>
        {links.map((source, index) => (
          <li key={source.url}>
            <a href={source.url} target="_blank" rel="noopener noreferrer">
              <span className="source-index">{index + 1}.</span>
              {source.title?.trim() || new URL(source.url).hostname}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
