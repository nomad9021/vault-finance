import { describe, expect, it } from "vitest";
import { parseAutoLock } from "../state/store.js";
import { shouldLock } from "./autoLock.js";

describe("auto-lock", () => {
  const t0 = 1_000_000_000;
  it("locks after the computer slept (the clock jumped)", () => {
    expect(shouldLock(t0 + 5_000, t0, t0, 0)).toBeNull();
    expect(shouldLock(t0 + 3 * 60_000, t0, t0 + 1_000, 0)).toBe("sleep");
  });

  it("locks after the idle minutes, never when set to 0", () => {
    expect(shouldLock(t0 + 5 * 60_000, t0 + 5 * 60_000 - 5_000, t0, 5)).toBe("idle");
    expect(shouldLock(t0 + 4 * 60_000, t0 + 4 * 60_000 - 5_000, t0, 5)).toBeNull();
    expect(shouldLock(t0 + 99 * 60_000, t0 + 99 * 60_000 - 5_000, t0, 0)).toBeNull();
  });

  it("reads the saved setting safely", () => {
    expect(parseAutoLock(null)).toBe(5);
    expect(parseAutoLock("15")).toBe(15);
    expect(parseAutoLock("0")).toBe(0);
    expect(parseAutoLock("banana")).toBe(5);
  });
});
