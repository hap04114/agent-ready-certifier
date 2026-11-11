import { describe, expect, it } from "vitest";
import { parseConfig } from "@certifier/config";
import { type StoreName, storeProfile } from "./stores.js";

const config = parseConfig({
  PAYPAL_ENV: "sandbox",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  DEMO_STORE_GOOD_STATUS_KEY: "good-key",
  DEMO_STORE_BUGGY_STATUS_KEY: "buggy-key",
  DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID: "id",
  DEMO_STORE_BUGGY_PAYPAL_CLIENT_SECRET: "secret",
});

describe("storeProfile", () => {
  it("resolves each demo store to its own URL", () => {
    const good = storeProfile(config, "good");
    const buggy = storeProfile(config, "buggy");
    expect("store" in good && good.store.url).toBe(config.DEMO_STORE_GOOD_URL);
    expect("store" in buggy && buggy.store.url).toBe(config.DEMO_STORE_BUGGY_URL);
  });

  it("refuses an unknown name instead of silently testing the buggy store", () => {
    // A benchmark once passed "good buggy" (PowerShell joined the list) and ran the buggy store 5 times.
    expect(() => storeProfile(config, "good buggy" as StoreName)).toThrow(/unknown demo store/);
  });
});
