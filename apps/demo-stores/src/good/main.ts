/**
 * Start demo-store-good.
 * Needs: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, DATABASE_URL.
 * Optional until webhooks are wired: DEMO_STORE_GOOD_WEBHOOK_ID, DEMO_STORE_GOOD_STATUS_KEY.
 * Exits with a clear message, naming only the missing variables, if required ones are empty.
 */
import { ConfigError, bootConfig, requireConfig } from "@certifier/config";
import { createPgDb } from "@certifier/db";
import { SandboxPaypal } from "@certifier/paypal";
import { migrateStore } from "./db.js";
import { buildGoodStore } from "./server.js";

const config = bootConfig("demo-store-good");

try {
  const { DATABASE_URL } = requireConfig(config, "demo-store-good", ["DATABASE_URL"]);
  const paypal = new SandboxPaypal(config, {
    audit: (entry) => console.log(JSON.stringify({ audit: "paypal", ...entry })),
  });
  const db = createPgDb(DATABASE_URL);
  const ran = await migrateStore(db).catch((err: unknown) => {
    console.error(`[demo-store-good] database unavailable or migration failed: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}`);
    process.exit(1);
  });
  if (ran.length) console.log(`[demo-store-good] migrations applied: ${ran.join(", ")}`);
  if (!config.DEMO_STORE_GOOD_WEBHOOK_ID) console.warn("[demo-store-good] DEMO_STORE_GOOD_WEBHOOK_ID not set: webhooks will be rejected");
  if (!config.DEMO_STORE_GOOD_STATUS_KEY) console.warn("[demo-store-good] DEMO_STORE_GOOD_STATUS_KEY not set: contract endpoints answer 503");

  const { app } = buildGoodStore({
    config,
    db,
    paypal,
    clientId: config.PAYPAL_CLIENT_ID!,
    webhookId: config.DEMO_STORE_GOOD_WEBHOOK_ID,
    statusKey: config.DEMO_STORE_GOOD_STATUS_KEY,
    publicUrl: config.DEMO_STORE_GOOD_URL.replace(/\/+$/, ""),
  });
  // Render injects PORT; locally the port comes from DEMO_STORE_GOOD_URL (default 5001).
  const port = Number(process.env.PORT || new URL(config.DEMO_STORE_GOOD_URL).port || 5001);
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[demo-store-good] ${err.message}`);
    process.exit(1);
  }
  console.error(`[demo-store-good] failed to start: ${err instanceof Error ? err.name : "unknown error"}`);
  process.exit(1);
}
