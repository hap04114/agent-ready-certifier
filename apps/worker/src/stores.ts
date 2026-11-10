/** The demo stores as certification targets, from configuration. */
import type { Config } from "@certifier/config";
import type { WorksRunOptions } from "./works.js";

export type StoreName = "good" | "buggy";

export function storeProfile(config: Config, name: StoreName): Pick<WorksRunOptions, "store" | "paypalCredentials"> | { missing: string[] } {
  if (name === "good") {
    if (!config.DEMO_STORE_GOOD_STATUS_KEY) return { missing: ["DEMO_STORE_GOOD_STATUS_KEY"] };
    return { store: { url: config.DEMO_STORE_GOOD_URL, statusKey: config.DEMO_STORE_GOOD_STATUS_KEY, webhookId: config.DEMO_STORE_GOOD_WEBHOOK_ID, demoHooks: true } };
  }
  const missing = (["DEMO_STORE_BUGGY_STATUS_KEY", "DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID", "DEMO_STORE_BUGGY_PAYPAL_CLIENT_SECRET"] as const).filter((k) => !config[k]);
  if (missing.length) return { missing };
  return {
    store: { url: config.DEMO_STORE_BUGGY_URL, statusKey: config.DEMO_STORE_BUGGY_STATUS_KEY!, webhookId: config.DEMO_STORE_BUGGY_WEBHOOK_ID, demoHooks: true },
    paypalCredentials: { clientId: config.DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID!, clientSecret: config.DEMO_STORE_BUGGY_PAYPAL_CLIENT_SECRET! },
  };
}
