import { describe, expect, it } from "vitest";
import { aprText, keptText, optionalPctText } from "./numberText.js";

/** Typing a decimal into a field rebuilt from its number used to lose the dot. */
describe("keptText", () => {
  const apr = (typed: string, value: number) => keptText(typed, value, aprText.show, aprText.parse);
  const pct = (typed: string, value: number | null) => keptText(typed, value, optionalPctText.show, optionalPctText.parse);

  it("keeps an APR's trailing dot so 6.5 can be typed", () => {
    expect(apr("6.", 6)).toBe("6.");
    expect(apr("6.5", 6.5)).toBe("6.5");
    expect(apr("6.50", 6.5)).toBe("6.50");
  });

  it("follows the value when it changed elsewhere", () => {
    expect(apr("6.", 22)).toBe("22");
    expect(pct("1.", 3)).toBe("3");
    expect(pct("1.", null)).toBe("");
  });

  it("keeps a % field's trailing dot and zeros", () => {
    expect(pct("1.", 1)).toBe("1.");
    expect(pct("1.0", 1)).toBe("1.0");
    expect(pct("", null)).toBe("");
  });

  it("APR text drops junk characters", () => {
    expect(aprText.clean("6.5%")).toBe("6.5");
    expect(aprText.parse("abc")).toBe(0);
  });
});
