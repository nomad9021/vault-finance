import { describe, expect, it } from "vitest";
import { moveWidget, placeWidget, resolveLayout } from "./dashboardLayout.js";

const defaults = [
  { id: "a", span: 3 as const },
  { id: "b", span: 12 as const },
  { id: "c", span: 4 as const },
];

describe("dashboard layout", () => {
  it("uses the defaults when nothing is saved", () => {
    expect(resolveLayout(defaults, undefined).map((w) => [w.id, w.span, w.hidden])).toEqual([["a", 3, false], ["b", 12, false], ["c", 4, false]]);
  });

  it("keeps the saved order, drops unknown widgets and appends new ones", () => {
    const out = resolveLayout(defaults, [{ id: "c", hidden: true, span: 6 }, { id: "gone", hidden: false }, { id: "a", hidden: false }]);
    expect(out).toEqual([
      { id: "c", hidden: true, span: 6 },
      { id: "a", hidden: false, span: 3 },
      { id: "b", hidden: false, span: 12 },
    ]);
  });

  it("moves and drops widgets", () => {
    const l = resolveLayout(defaults, undefined);
    expect(moveWidget(l, "b", -1).map((w) => w.id)).toEqual(["b", "a", "c"]);
    expect(moveWidget(l, "a", -1)).toBe(l);
    expect(placeWidget(l, "c", "a").map((w) => w.id)).toEqual(["c", "a", "b"]);
  });
});
