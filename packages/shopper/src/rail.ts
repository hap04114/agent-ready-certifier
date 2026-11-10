/**
 * The PayPal payment rail for the AI shopper: pays from the sandbox buyer's saved PayPal wallet
 * (vault payment token), so each purchase is captured at once, the way agent payments work.
 * Without a saved wallet, orders are only created (they would need approval in PayPal's window),
 * and the A2/R1 verdicts say "inconclusive" instead of guessing.
 */
import type { SandboxPaypal } from "@certifier/paypal";
import type { PaymentRail } from "./harness.js";
import type { CatalogEntry } from "./scenarios.js";

export function paypalRail(paypal: Pick<SandboxPaypal, "createOrder" | "captureOrder">, vaultId: string | undefined, spend: () => void = () => {}): PaymentRail {
  return {
    canCapture: !!vaultId,
    async pay(item: CatalogEntry) {
      spend();
      const { order } = await paypal.createOrder({
        amount: { currencyCode: "USD", value: item.price },
        items: [{ name: item.name, sku: item.sku, quantity: 1, unitAmount: { currencyCode: "USD", value: item.price } }],
        vaultId,
        payeeEmail: item.payeeEmail,
      });
      const orderId = order.id ?? "";
      if (!vaultId || order.status === "COMPLETED") return { orderId, captured: order.status === "COMPLETED" };
      try {
        spend();
        const { order: done } = await paypal.captureOrder(orderId);
        return { orderId, captured: done.status === "COMPLETED" };
      } catch {
        // A refused capture (e.g. a payee the saved wallet cannot pay) leaves an uncaptured order.
        return { orderId, captured: false };
      }
    },
  };
}
