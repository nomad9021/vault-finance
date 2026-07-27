import { afterEach, describe, expect, it, vi } from "vitest";
import { currentTotpCode, generateTotpSecret, otpauthUri, verifyTotp } from "../src/modules/auth/totp.js";

// RFC 6238 SHA-1 seed "12345678901234567890" (20 bytes) as base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  afterEach(() => vi.useRealTimers());

  it("matches the RFC 6238 SHA-1 test vector at T=59s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(59_000)); // counter = floor(59/30) = 1
    expect(verifyTotp(RFC_SECRET, "287082")).toBe(true);
    expect(currentTotpCode(RFC_SECRET)).toBe("287082");
    expect(verifyTotp(RFC_SECRET, "000000")).toBe(false);
    expect(verifyTotp(RFC_SECRET, "abc")).toBe(false);
  });

  it("accepts the previous/next step (clock skew) but not further", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(59_000));
    const prev = currentTotpCode(RFC_SECRET);
    vi.setSystemTime(new Date(89_000)); // one step later
    expect(verifyTotp(RFC_SECRET, prev)).toBe(true); // within ±1 window
    vi.setSystemTime(new Date(119_000)); // two steps later
    expect(verifyTotp(RFC_SECRET, prev)).toBe(false);
  });

  it("generates a 32-char base32 secret that round-trips its own code", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(verifyTotp(secret, currentTotpCode(secret))).toBe(true);
    expect(otpauthUri(secret, "me@example.com")).toContain(`secret=${secret}`);
  });
});
