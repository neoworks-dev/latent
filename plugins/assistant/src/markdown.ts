// The Markdown an agent answers in, parsed by `marked` and handed to a Svelte component as a
// small node tree it draws element by element. Never HTML: a reply is model output, and
// `{@html}` of it in an Electron renderer would run whatever it said — so raw HTML in a
// reply is shown as its text, and a link is its text only (following it would navigate the
// app's one window).
import { lexer, type Token, type Tokens } from "marked";

export type MarkdownNode =
  | {
      kind: "paragraph" | "item" | "strong" | "em" | "del" | "blockquote";
      children: MarkdownNode[];
    }
  | { kind: "heading"; level: number; children: MarkdownNode[] }
  | { kind: "list"; ordered: boolean; children: MarkdownNode[] }
  /** A fenced or indented block. */
  | { kind: "code"; text: string }
  /** Backticks inside a line. */
  | { kind: "codespan"; text: string }
  | { kind: "text"; text: string }
  | { kind: "break" }
  | { kind: "rule" };

export function parseMarkdown(source: string): MarkdownNode[] {
  return toNodes(lexer(source));
}

function toNodes(tokens: Token[] | undefined): MarkdownNode[] {
  return (tokens ?? []).flatMap(toNode);
}

function toNode(token: Token): MarkdownNode[] {
  switch (token.type) {
    case "paragraph":
    case "strong":
    case "em":
    case "del":
    case "blockquote":
      return [{ kind: token.type, children: toNodes(token.tokens) }];
    case "heading":
      return [{ kind: "heading", level: token.depth, children: toNodes(token.tokens) }];
    case "list":
      return [
        {
          kind: "list",
          ordered: token.ordered,
          children: token.items.map((item: Tokens.ListItem) => ({
            kind: "item",
            children: toNodes(item.tokens),
          })),
        },
      ];
    case "code":
      return [{ kind: "code", text: token.text }];
    case "codespan":
      return [{ kind: "codespan", text: token.text }];
    // A tight list item's text carries its own inline tokens.
    case "text":
      return token.tokens ? toNodes(token.tokens) : [{ kind: "text", text: token.text }];
    case "link":
      return toNodes(token.tokens);
    case "br":
      return [{ kind: "break" }];
    case "hr":
      return [{ kind: "rule" }];
    case "space":
      return [];
    // `html`, `escape`, tables and anything newer: its text, as written.
    default:
      return [{ kind: "text", text: token.raw }];
  }
}
