import { describe, expect, test } from "bun:test";
import { paneModes, panesForMode } from "../src/panes";

const panes = [
  { id: "stack" },
  { id: "edit", mode: "edit" },
  { id: "info", mode: "info" },
  { id: "history", mode: "info" },
];

describe("rail modes", () => {
  test("a pane without a mode shows in every mode", () => {
    expect(panesForMode(panes, "edit").map((pane) => pane.id)).toEqual(["stack", "edit"]);
    expect(panesForMode(panes, "info").map((pane) => pane.id)).toEqual([
      "stack",
      "info",
      "history",
    ]);
    expect(panesForMode(panes, "crop").map((pane) => pane.id)).toEqual(["stack"]);
  });

  test("the rail lists each mode once, in registration order", () => {
    expect(paneModes(panes)).toEqual(["edit", "info"]);
    expect(paneModes(panes.filter((pane) => pane.mode === undefined))).toEqual([]);
  });
});
