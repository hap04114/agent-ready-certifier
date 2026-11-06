/**
 * Milestone 1 check: `pnpm verify:order <PAYPAL_ORDER_ID>`
 * Reads the order from PayPal sandbox and the store's status endpoint and prints whether
 * they agree. This is a stand-in until the truth checker (Milestone 2) replaces it.
 */
import { ConfigError, bootConfig } from "@certifier/config";
import { PaypalCallError, SandboxPaypal, captureIdsOf } from "@certifier/paypal";

const orderId = process.argv[2];
const storeUrl = process.argv[3] ?? "http://localhost:5001";
if (!orderId || !/^[A-Z0-9]{5,40}$/.test(orderId)) {
  console.error("usage: pnpm verify:order <PAYPAL_ORDER_ID> [store base url]");
  process.exit(2);
}

const config = bootConfig("verify-order");
try {
  const paypal = new SandboxPaypal(config);
  const order = await paypal.getOrder(orderId);
  const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
  const storeRes = await fetch(`${storeUrl}/api/status/${orderId}`);
  const store = storeRes.ok ? ((await storeRes.json()) as { status: string; amount: { value: string; currencyCode: string } }) : undefined;

  const checks = {
    "PayPal order COMPLETED": order.status === "COMPLETED",
    "PayPal capture COMPLETED": capture?.status === "COMPLETED",
    "store shows paid": store?.status === "paid",
    "amounts match": !!store && capture?.amount?.value === store.amount.value && capture?.amount?.currencyCode === store.amount.currencyCode,
  };
  console.log(JSON.stringify({ orderId, orderStatus: order.status, captureIds: captureIdsOf(order), storeStatus: store?.status ?? "unavailable" }, null, 2));
  for (const [name, pass] of Object.entries(checks)) console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
} catch (err) {
  if (err instanceof ConfigError || err instanceof PaypalCallError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
