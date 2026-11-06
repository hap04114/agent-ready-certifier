/**
 * Certifier API entry point. Exits before listening if the config is not sandbox-safe.
 * With DATABASE_URL and PAYPAL_WEBHOOK_ID set, the webhook listener is active.
 */
import { bootConfig } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { buildApi } from "./server.js";

const config = bootConfig("api");

let repo: ReturnType<typeof certifierRepo> | undefined;
if (config.DATABASE_URL) {
  const db = createPgDb(config.DATABASE_URL);
  try {
    const ran = await migrateCertifier(db);
    if (ran.length) console.log(`[api] migrations applied: ${ran.join(", ")}`);
    repo = certifierRepo(db);
  } catch (err) {
    console.error(`[api] database unavailable or migration failed: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}`);
    process.exit(1);
  }
} else {
  console.warn("[api] DATABASE_URL not set: webhook listener disabled");
}
if (!config.PAYPAL_WEBHOOK_ID) console.warn("[api] PAYPAL_WEBHOOK_ID not set: webhook listener disabled");

const app = buildApi(config, { repo });
// Render injects PORT; locally we use the port in API_BASE_URL.
const port = Number(process.env.PORT || new URL(config.API_BASE_URL).port || 4000);

app.listen({ port, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err instanceof Error ? err.message : "listen failed");
  process.exit(1);
});
