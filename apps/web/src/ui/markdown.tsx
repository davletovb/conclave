import React from "react";

type MarkdownProps = {
  content: string;
};

function safeLink(href: string) {
  return /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

function inline(content: string, prefix: string): React.ReactNode[] {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^\s)]+\))/g;
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(content.slice(cursor, start));
    const token = match[0];
    const key = `${prefix}-${index++}`;

    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link ? safeLink(link[2]) : null;
      nodes.push(href
        ? <a key={key} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined}>{link?.[1]}</a>
        : token);
    } else {
      nodes.push(token);
    }

    cursor = start + token.length;
  }

  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

function inlineWithBreaks(content: string, prefix: string) {
  const lines = content.split("\n");
  return lines.flatMap((line, index) => [
    ...inline(line, `${prefix}-line-${index}`),
    ...(index < lines.length - 1 ? [<br key={`${prefix}-br-${index}`} />] : []),
  ]);
}

function isTableDivider(line: string) {
  const trimmed = line.trim().replace(/^\||\|$/g, "");
  const cells = trimmed.split("|").map(cell => cell.trim());
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function tableCells(line: string) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
}

function heading(level: number, children: React.ReactNode, key: string) {
  if (level === 1) return <h1 key={key}>{children}</h1>;
  if (level === 2) return <h2 key={key}>{children}</h2>;
  if (level === 3) return <h3 key={key}>{children}</h3>;
  if (level === 4) return <h4 key={key}>{children}</h4>;
  if (level === 5) return <h5 key={key}>{children}</h5>;
  return <h6 key={key}>{children}</h6>;
}

function startsBlock(line: string, nextLine?: string) {
  return /^\s*$/.test(line)
    || /^\s*```/.test(line)
    || /^\s*#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*[-+*]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || (line.includes("|") && Boolean(nextLine && isTableDivider(nextLine)));
}

export function Markdown({ content }: MarkdownProps) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let index = 0;
  let block = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const language = fence[1].trim().replace(/[^a-zA-Z0-9_-]/g, "");
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`block-${block++}`}><code className={language ? `language-${language}` : undefined}>{code.join("\n")}</code></pre>,
      );
      continue;
    }

    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push(heading(headingMatch[1].length, inline(headingMatch[2], `heading-${block}`), `block-${block++}`));
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      const key = `block-${block++}`;
      blocks.push(
        <div className="markdown-table-wrap" key={key}>
          <table>
            <thead><tr>{headers.map((cell, cellIndex) => <th key={`${key}-h-${cellIndex}`}>{inline(cell, `${key}-h-${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => (
              <tr key={`${key}-r-${rowIndex}`}>{headers.map((_, cellIndex) => <td key={`${key}-r-${rowIndex}-c-${cellIndex}`}>{inline(row[cellIndex] ?? "", `${key}-r-${rowIndex}-c-${cellIndex}`)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      const key = `block-${block++}`;
      blocks.push(<blockquote key={key}>{inlineWithBreaks(quote.join("\n"), `quote-${key}`)}</blockquote>);
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-+*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      const key = `block-${block++}`;
      blocks.push(<ul key={key}>{items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+\.\s+(.+)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      const key = `block-${block++}`;
      blocks.push(<ol key={key}>{items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{inline(item, `${key}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={`block-${block++}`} />);
      index += 1;
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index], lines[index + 1])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    const key = `block-${block++}`;
    blocks.push(<p key={key}>{inlineWithBreaks(paragraph.join("\n"), `paragraph-${key}`)}</p>);
  }

  return <div className="markdown">{blocks}</div>;
}
