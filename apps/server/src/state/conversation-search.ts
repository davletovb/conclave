import type { Conversation } from "@conclave/core";

const SNIPPET_RADIUS = 48;
const MAX_TERMS = 8;

/**
 * Split a raw query into lowercase terms. Quoted groups stay together so a
 * phrase can be matched verbatim.
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim().toLowerCase();
    if (term) terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

/** Every term must appear in the title or in some message. */
export function matchesConversation(conversation: Conversation, terms: string[]) {
  if (terms.length === 0) return true;
  const haystack = [conversation.title, ...conversation.messages.map(message => message.content)]
    .join("\n")
    .toLowerCase();
  return terms.every(term => haystack.includes(term));
}

/**
 * Excerpt around the first message hit so the sidebar can show why a
 * conversation matched instead of only repeating its title.
 */
export function conversationSnippet(conversation: Conversation, terms: string[]) {
  if (terms.length === 0) return undefined;

  for (const message of conversation.messages) {
    const haystack = message.content.toLowerCase();
    let index = -1;
    for (const term of terms) {
      const found = haystack.indexOf(term);
      if (found >= 0 && (index < 0 || found < index)) index = found;
    }
    if (index < 0) continue;

    const compact = message.content.replace(/\s+/g, " ").trim();
    const compactIndex = compact.toLowerCase().indexOf(
      terms.map(term => ({ term, at: haystack.indexOf(term) }))
        .filter(entry => entry.at >= 0)
        .sort((a, b) => a.at - b.at)[0].term,
    );
    const start = Math.max(0, compactIndex - SNIPPET_RADIUS);
    const end = Math.min(compact.length, compactIndex + SNIPPET_RADIUS * 2);
    const excerpt = compact.slice(start, end);
    return `${start > 0 ? "…" : ""}${excerpt}${end < compact.length ? "…" : ""}`;
  }

  return undefined;
}
