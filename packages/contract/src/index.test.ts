import { describe, expect, it } from "vitest";
import { bearerMatches, deriveStatusKey, statusPath, storeOrigin, testHookRequest } from "./index.js";

const SECRET = "x".repeat(40);

describe("store contract", () => {
  it("derives a stable key per store origin", () => {
    const a = deriveStatusKey(SECRET, "http://localhost:5001/some/path");
    expect(a).toBe(deriveStatusKey(SECRET, "http://LOCALHOST:5001"));
    expect(a).not.toBe(deriveStatusKey(SECRET, "http://localhost:5002"));
    expect(a).not.toBe(deriveStatusKey("y".repeat(40), "http://localhost:5001"));
    expect(storeOrigin("https://Shop.Example.com/x?y")).toBe("https://shop.example.com");
  });

  it("refuses a short secret", () => {
    expect(() => deriveStatusKey("short", "http://localhost")).toThrow(/at least 32/);
  });

  it("checks bearer keys exactly", () => {
    expect(bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerMatches("Bearer abcd", "abc")).toBe(false);
    expect(bearerMatches("abc", "abc")).toBe(false);
    expect(bearerMatches(undefined, "abc")).toBe(false);
    expect(bearerMatches("Bearer abc", undefined)).toBe(false);
  });

  it("allows only the two sandbox mock codes", () => {
    expect(testHookRequest.safeParse({ paypalOrderId: "ORDER123", mock: "INSTRUMENT_DECLINED" }).success).toBe(true);
    expect(testHookRequest.safeParse({ paypalOrderId: "ORDER123", mock: "ANYTHING_ELSE" }).success).toBe(false);
    expect(testHookRequest.safeParse({ paypalOrderId: "../x", mock: "INSTRUMENT_DECLINED" }).success).toBe(false);
  });

  it("escapes order IDs in paths", () => {
    expect(statusPath("A/B")).toBe("/.well-known/certifier/orders/A%2FB");
  });
});
