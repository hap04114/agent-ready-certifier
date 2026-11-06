/**
 * `pnpm paypal:cross-read <ORDER_ID>` — can one sandbox merchant read another merchant's order?
 * Reads ORDER_ID (created by the demo-store-good app) using the SECOND app's credentials
 * (PAYPAL_LOOKALIKE_CLIENT_ID / _SECRET). Prints only the HTTP outcome and PayPal issue names.
 */
import { ConfigError, bootConfig, requireConfig } from "@certifier/config";
import { PaypalCallError, SandboxPaypal } from "@certifier/paypal";

const orderId = process.argv[2];
if (!orderId || !/^[A-Z0-9]{5,40}$/.test(orderId)) {
  console.error("usage: pnpm paypal:cross-read <ORDER_ID created by demo-store-good>");
  process.exit(2);
}
const config = bootConfig("cross-read");
try {
  const other = requireConfig(config, "cross-read", ["PAYPAL_LOOKALIKE_CLIENT_ID", "PAYPAL_LOOKALIKE_CLIENT_SECRET"]);
  const asOther = new SandboxPaypal({ ...config, PAYPAL_CLIENT_ID: other.PAYPAL_LOOKALIKE_CLIENT_ID, PAYPAL_CLIENT_SECRET: other.PAYPAL_LOOKALIKE_CLIENT_SECRET });
  const order = await asOther.getOrder(orderId);
  console.log(`READABLE: the second merchant can read order ${orderId} (status ${order.status}).`);
} catch (err) {
  if (err instanceof PaypalCallError) {
    console.log(`NOT READABLE: HTTP ${err.statusCode ?? "?"} ${err.issues.join(", ")}${err.debugId ? ` (debug id ${err.debugId})` : ""}`);
  } else if (err instanceof ConfigError) {
    console.error(err.message);
    process.exitCode = 1;
  } else throw err;
}
