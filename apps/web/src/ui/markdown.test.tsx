import { describe, expect, it } from "vitest";
import React from "react";
import { Markdown } from "./markdown";

function blockKeys(content: string) {
  const rendered = Markdown({ content }) as React.ReactElement<{ children: React.ReactNode }>;
  return React.Children.toArray(rendered.props.children)
    .filter((child): child is React.ReactElement => React.isValidElement(child))
    .map(child => String(child.key));
}

describe("Markdown", () => {
  it("gives every block a unique key", () => {
    // A paragraph or quote followed by another block used to collide: the key
    // was read after the children had already advanced the counter, so React
    // could drop or duplicate blocks in a long answer.
    const content = [
      "# Heading",
      "",
      "A paragraph of prose.",
      "",
      "---",
      "",
      "> A quotation.",
      "",
      "Another paragraph.",
      "",
      "- one",
      "- two",
      "",
      "Final paragraph.",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Trailing paragraph.",
    ].join("\n");

    const keys = blockKeys(content);
    expect(keys.length).toBeGreaterThan(8);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps keys unique for a long alternating document", () => {
    const content = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}.\n\n---\n`).join("\n");
    const keys = blockKeys(content);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
