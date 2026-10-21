import { describe, expect, it } from "vitest";
import { describeAiAction, extractAssistantBlocks, stripAssistantBlocks } from "./schemas/ai-actions.js";

describe("assistant blocks", () => {
  it("pulls out valid actions and memory notes, reports bad ones", () => {
    const out = extractAssistantBlocks(
      [
        "Here's the plan.",
        '<vault-action>{"type":"set_budget","category":"Dining","amount":250}</vault-action>',
        '<vault-action>{"type":"drop_tables"}</vault-action>',
        "<vault-action>not json</vault-action>",
        "<vault-remember>Paid biweekly on Fridays</vault-remember>",
      ].join("\n"),
    );
    expect(out.visible).toBe("Here's the plan.");
    expect(out.actions).toEqual([{ type: "set_budget", category: "Dining", amount: 250 }]);
    expect(out.invalid).toHaveLength(2);
    expect(out.remember).toEqual(["Paid biweekly on Fridays"]);
  });

  it("reads blocks small models mangle", () => {
    const out = extractAssistantBlocks(
      'Done.\n$vault-action{"type":"set_budget","category":"Groceries","amount":500}</vault-action>\n' +
        '<vault-action>```json\n{"type":"create_rule","keyword":"shell","category":"Transport"}\n```</vault-action>',
    );
    expect(out.actions.map((a) => a.type)).toEqual(["set_budget", "create_rule"]);
    expect(out.visible).toBe("Done.\n$");
    expect(extractAssistantBlocks('<vault-action>{\u201Ctype\u201D:\u201Crename_category\u201D,\u201Ccategory\u201D:\u201CDining Out\u201D,\u201CnewName\u201D:\u201CRestaurants\u201D}</vault-action>').actions).toEqual([
      { type: "rename_category", category: "Dining Out", newName: "Restaurants" },
    ]);
  });

  it("hides a block that is still streaming in", () => {
    expect(stripAssistantBlocks('Okay.\n<vault-action>{"type":"create_')).toBe("Okay.");
  });

  it("describes actions in plain words", () => {
    expect(describeAiAction({ type: "move_category", category: "Vet", newParent: null })).toBe(
      'Make "Vet" a top-level category',
    );
  });
});
