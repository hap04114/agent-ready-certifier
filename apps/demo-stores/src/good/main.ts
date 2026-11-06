/**
 * Start demo-store-good. Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox).
 * Exits with a clear message, naming only the missing variables, if they are empty.
 */
import { ConfigError, bootConfig } from "@certifier/config";
import { SandboxPaypal } from "@certifier/paypal";
import { buildGoodStore } from "./server.js";

const config = bootConfig("demo-store-good");

let paypal: SandboxPaypal;
try {
  paypal = new SandboxPaypal(config, {
    audit: (entry) => console.log(JSON.stringify({ audit: "paypal", ...entry })),
  });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[demo-store-good] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const { app } = buildGoodStore({ config, paypal, clientId: config.PAYPAL_CLIENT_ID! });
// Render injects PORT; locally the good store runs on 5001.
const port = Number(process.env.PORT || 5001);
app.listen({ port, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err instanceof Error ? err.message : "listen failed");
  process.exit(1);
});
