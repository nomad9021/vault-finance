import { describe, expect, it } from "vitest";
import { applyDashboardChange, AiAction, DASHBOARD_WIDGETS, unknownWidgetIds } from "./index.js";

describe("home screen changes from the assistant", () => {
  it("puts the named widgets first and keeps the rest in order", () => {
    const out = applyDashboardChange(undefined, { order: ["guilt-free", "bills"], hide: ["investments"], widths: { bills: "half" } });
    expect(out.slice(0, 2).map((w) => w.id)).toEqual(["guilt-free", "bills"]);
    expect(out.map((w) => w.id).slice(2)).toEqual(DASHBOARD_WIDGETS.map((w) => w.id).filter((id) => id !== "guilt-free" && id !== "bills"));
    expect(out.find((w) => w.id === "investments")!.hidden).toBe(true);
    expect(out.find((w) => w.id === "bills")!.span).toBe(6);
  });
  it("builds on the saved layout, or resets it", () => {
    const saved = [{ id: "goals", hidden: true }, { id: "sankey" }];
    expect(applyDashboardChange(saved, { show: ["goals"] })[0]).toEqual({ id: "goals", hidden: false, span: 4 });
    expect(applyDashboardChange(saved, { reset: true })[0]!.id).toBe(DASHBOARD_WIDGETS[0]!.id);
  });
  it("flags ids that aren't widgets", () => {
    expect(unknownWidgetIds({ order: ["sankey", "weather"], hide: ["clock"] })).toEqual(["weather", "clock"]);
  });
  it("parses the new actions", () => {
    expect(AiAction.safeParse({ type: "set_dashboard_layout", order: ["guilt-free"], widths: { sankey: "full" }, sankeyView: "combined" }).success).toBe(true);
    expect(AiAction.safeParse({ type: "set_dashboard_layout", widths: { sankey: "huge" } }).success).toBe(false);
    expect(AiAction.safeParse({ type: "set_guilt_free", person: "me", weekly: 75 }).success).toBe(true);
    expect(AiAction.safeParse({ type: "set_budget", category: "Coffee", amount: 20, period: "weekly" }).success).toBe(true);
  });
});
