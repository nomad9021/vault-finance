import { describe, expect, it } from "vitest";
import { excelDate, tidyNumber } from "./spreadsheet.js";

describe("reading Excel numbers", () => {
  it("turns Excel day counts into dates", () => {
    expect(excelDate(46266)).toBe("2026-09-01");
    expect(excelDate(45658)).toBe("2025-01-01");
    expect(tidyNumber("46266", "date")).toBe("2026-09-01");
  });
  it("shows percentages as percentages and money to the cent", () => {
    expect(tidyNumber("0.15", "percent")).toBe("15%");
    expect(tidyNumber("0.9742314207", "percent")).toBe("97.42%");
    expect(tidyNumber("3180.903667", "number")).toBe("3180.9");
    expect(tidyNumber("8.333333333", "number")).toBe("8.33");
    expect(tidyNumber("1375", "number")).toBe("1375");
    expect(tidyNumber("abc", "number")).toBe("abc");
  });
});
