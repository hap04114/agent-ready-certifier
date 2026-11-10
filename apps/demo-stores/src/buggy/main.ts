/**
 * Start demo-store-buggy: the same store code as demo-store-good with EVERY seeded bug switched
 * on (docs/seeded-bugs.md). It uses its own throwaway sandbox app, because one seeded bug
 * deliberately exposes that app's client secret. Sandbox only, like everything here.
 */
import { ConfigError, bootConfig, requireConfig } from "@certifier/config";
import { createPgDb, describeDbError } from "@certifier/db";
import { SandboxPaypal } from "@certifier/paypal";
import { migrateStore } from "../good/db.js";
import { SEEDED_BUGS, buildGoodStore } from "../good/server.js";

const SCHEMA = "demo_store_buggy";
const config = bootConfig("demo-store-buggy");

try {
  const env = requireConfig(config, "demo-store-buggy", ["DATABASE_URL", "DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID", "DEMO_STORE_BUGGY_PAYPAL_CLIENT_SECRET"]);
  // The buggy store talks to PayPal with ITS OWN app's credentials (still sandbox-only).
  const paypal = new SandboxPaypal(
    { ...config, PAYPAL_CLIENT_ID: env.DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: env.DEMO_STORE_BUGGY_PAYPAL_CLIENT_SECRET },
    { audit: (entry) => console.log(JSON.stringify({ audit: "paypal", ...entry })) },
  );
  const db = createPgDb(env.DATABASE_URL);
  const ran = await migrateStore(db, SCHEMA).catch((err: unknown) => {
    console.error(`[demo-store-buggy] database unavailable or migration failed: ${describeDbError(err)}`);
    process.exit(1);
  });
  if (ran.length) console.log(`[demo-store-buggy] migrations applied: ${ran.join(", ")}`);
  console.warn(`[demo-store-buggy] SEEDED BUGS ON: ${SEEDED_BUGS.join(", ")}`);

  const { app } = buildGoodStore({
    config,
    db,
    schema: SCHEMA,
    brand: "Buggy Demo Store",
    bugs: new Set(SEEDED_BUGS),
    exposedSecret: env.DEMO_STORE_BUGGY_PAYPAL_CLIENT_SECRET,
    paypal,
    clientId: env.DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID,
    webhookId: config.DEMO_STORE_BUGGY_WEBHOOK_ID,
    statusKey: config.DEMO_STORE_BUGGY_STATUS_KEY,
    ownershipToken: config.DEMO_STORE_BUGGY_OWNERSHIP_TOKEN,
    publicUrl: config.DEMO_STORE_BUGGY_URL.replace(/\/+$/, ""),
  });
  const port = Number(process.env.PORT || new URL(config.DEMO_STORE_BUGGY_URL).port || 5002);
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[demo-store-buggy] ${err.message}`);
    process.exit(1);
  }
  console.error(`[demo-store-buggy] failed to start: ${err instanceof Error ? err.name : "unknown error"}`);
  process.exit(1);
}
