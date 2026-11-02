import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { safeSources, SourceLinks } from "./sources";

describe("native web source links", () => {
  const citations = [
    { url: "https://example.org/article", title: "First source" },
    { url: "https://example.org/article", title: "Duplicate" },
    { url: "javascript:alert(1)", title: "Unsafe protocol" },
    { url: "mailto:help@example.org", title: "Email" },
    { url: "https://example.org/second", title: "<script>alert('unsafe')</script>" },
  ];

  it("rejects unsafe links and collapses repeated source URLs", () => {
    expect(safeSources(citations)).toEqual([
      { url: "https://example.org/article", title: "First source" },
      { url: "https://example.org/second", title: "<script>alert('unsafe')</script>" },
    ]);
  });

  it("renders accessible citations without interpreting titles as HTML", () => {
    const markup = renderToStaticMarkup(React.createElement(SourceLinks, { sources: citations }));
    expect(markup).toContain('aria-label="Web sources"');
    expect(markup).toContain('href="https://example.org/article"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain('href="javascript:');
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });

  it("does not display a sources section when none are usable", () => {
    expect(renderToStaticMarkup(React.createElement(SourceLinks, { sources: [] }))).toBe("");
    expect(renderToStaticMarkup(React.createElement(SourceLinks, { sources: [{ url: "data:text/html,hi" }] }))).toBe("");
  });
});
