import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../src/markdown";

describe("markdown", () => {
  test("marked's blocks and inlines become nodes", () => {
    const text = ["## Tone", "Clouds clip at **9%**.", "", "- highlights `-80`", "- whites"].join(
      "\n",
    );
    expect(parseMarkdown(text)).toEqual([
      { kind: "heading", level: 2, children: [{ kind: "text", text: "Tone" }] },
      {
        kind: "paragraph",
        children: [
          { kind: "text", text: "Clouds clip at " },
          { kind: "strong", children: [{ kind: "text", text: "9%" }] },
          { kind: "text", text: "." },
        ],
      },
      {
        kind: "list",
        ordered: false,
        children: [
          {
            kind: "item",
            children: [
              { kind: "text", text: "highlights " },
              { kind: "codespan", text: "-80" },
            ],
          },
          { kind: "item", children: [{ kind: "text", text: "whites" }] },
        ],
      },
    ]);
  });

  test("raw HTML stays text and a link is only its text", () => {
    expect(parseMarkdown("<img src=x onerror=alert(1)> [here](https://example.com)")).toEqual([
      {
        kind: "paragraph",
        children: [
          { kind: "text", text: "<img src=x onerror=alert(1)>" },
          { kind: "text", text: " " },
          { kind: "text", text: "here" },
        ],
      },
    ]);
  });

  test("a fence still open mid-stream holds what has arrived", () => {
    expect(parseMarkdown("```\nx = 1")).toEqual([{ kind: "code", text: "x = 1" }]);
  });
});
