/**
 * Quick check: `pnpm verify:order <PAYPAL_ORDER_ID>`
 * Reads the order from PayPal sandbox and the store's contract status endpoint and prints
 * whether they agree, using the same W1 rule as the truth checker.
 */
import { ConfigError, bootConfig, requireConfig } from "@certifier/config";
import { statusPath, storeOrderStatus } from "@certifier/contract";
import { PaypalCallError, SandboxPaypal } from "@certifier/paypal";
import { judgeW1, orderSnap } from "@certifier/truth";


const orderId = process.argv[2];
if (!orderId || !/^[A-Z0-9]{5,40}$/.test(orderId)) {
  console.error("usage: pnpm verify:order <PAYPAL_ORDER_ID>");
  process.exit(2);
}

const config = bootConfig("verify-order");
try {
  const { DEMO_STORE_GOOD_STATUS_KEY } = requireConfig(config, "verify-order", ["DEMO_STORE_GOOD_STATUS_KEY"]);
  const paypal = new SandboxPaypal(config);
  const order = orderSnap(await paypal.getOrder(orderId));
  const res = await fetch(new URL(statusPath(orderId), config.DEMO_STORE_GOOD_URL), {
    headers: { authorization: `Bearer ${DEMO_STORE_GOOD_STATUS_KEY}` },
  });
  const store = res.ok ? storeOrderStatus.parse(await res.json()) : undefined;
  const v = judgeW1({ order, store });
  console.log(`${v.status.toUpperCase()}  W1  ${v.summary}`);
  for (const r of v.reasons) console.log(`      - ${r}`);
  for (const e of v.evidence) console.log(`      evidence: ${e.kind} ${e.id} [${e.strength}] ${e.note ?? ""}`);
  process.exit(v.status === "pass" ? 0 : 1);
} catch (err) {
  if (err instanceof ConfigError || err instanceof PaypalCallError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
