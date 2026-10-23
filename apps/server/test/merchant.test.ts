import { describe, expect, it } from "vitest";
import { billMatchesMerchant, normalizeMerchant } from "../src/modules/subscriptions/merchant.js";

describe("billMatchesMerchant", () => {
  const m = (bill: string, merchant: string) => billMatchesMerchant(bill, normalizeMerchant(merchant));
  it("matches the same merchant despite noise", () => {
    expect(m("Netflix", "NETFLIX.COM #4411")).toBe(true);
    expect(m("Oakwood Property Mgmt", "Oakwood Property Mgmt")).toBe(true);
    expect(m("City Power & Light", "City Power")).toBe(true);
  });
  it("needs whole words", () => {
    expect(m("Rent", "Lakeside Rentals")).toBe(false);
    expect(m("Gas", "Gasoline Depot")).toBe(false);
  });
  it("ignores too-short bill names", () => {
    expect(m("TV", "TV Store")).toBe(false);
  });
});
