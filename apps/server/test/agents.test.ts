import { describe, expect, it } from "vitest";
import { AGENTS, routeAgents } from "../src/modules/ai/agents.js";

describe("agent router", () => {
  it("picks agents from what the user says", () => {
    expect(routeAgents("What's my take-home after a raise?")).toContain("tax");
    expect(routeAgents("Add my Netflix subscription as a bill")).toEqual(expect.arrayContaining(["bills"]));
    expect(routeAgents("Pay off my credit card faster")).toContain("debt");
    expect(routeAgents("switch to dark theme")).toEqual(["app"]);
  });

  it("turns everything on for organize-everything requests", () => {
    expect(routeAgents("Organize my finances and set up my Sankey")).toHaveLength(AGENTS.length);
  });

  it("follows the conversation, then falls back to a general set", () => {
    expect(routeAgents("ok do it", "what would I make in Texas?")).toContain("tax");
    expect(routeAgents("hello")).toEqual(["organizer", "budget", "insights"]);
  });
});
