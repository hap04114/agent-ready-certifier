/**
 * Convert raw records into truth snapshots. Structural types only, so the truth package does
 * not depend on the PayPal SDK. These run before judgment; rules never see raw payloads.
 */
import type { DeliverySnap, PaypalOrderSnap, PaypalRefundSnap } from "./types.js";

interface MoneyLike {
  currencyCode?: string;
  value?: string;
}
const money = (m: MoneyLike | undefined) => (m?.currencyCode && m.value ? { currencyCode: m.currencyCode, value: m.value } : undefined);

export interface OrderLike {
  id?: string;
  status?: string;
  purchaseUnits?: {
    amount?: MoneyLike;
    items?: { sku?: string; name?: string; unitAmount?: MoneyLike }[];
    payments?: { captures?: { id?: string; status?: string; amount?: MoneyLike }[] };
  }[];
}

/** Line items PayPal recorded on an order (for A4), with the order ID. */
export function chargedItems(order: OrderLike): { orderId: string; sku?: string; name?: string; unit?: { currencyCode: string; value: string } }[] {
  return (order.purchaseUnits ?? []).flatMap((u) => (u.items ?? []).map((i) => ({ orderId: order.id ?? "", sku: i.sku, name: i.name, unit: money(i.unitAmount) })));
}

export function orderSnap(order: OrderLike): PaypalOrderSnap {
  const pu = order.purchaseUnits?.[0];
  return {
    id: order.id ?? "",
    status: order.status ?? "UNKNOWN",
    amount: money(pu?.amount),
    captures: (order.purchaseUnits ?? []).flatMap((u) =>
      (u.payments?.captures ?? []).filter((c) => c.id).map((c) => ({ id: c.id!, status: c.status ?? "UNKNOWN", amount: money(c.amount) })),
    ),
  };
}

export function refundSnap(refund: { id?: string; status?: string; amount?: MoneyLike }): PaypalRefundSnap {
  return { id: refund.id ?? "", status: refund.status ?? "UNKNOWN", amount: money(refund.amount) };
}

export function deliverySnap(event: { id: string; transmissions?: { webhook_url?: string; http_status?: number; status?: string }[] }): DeliverySnap {
  return {
    eventId: event.id,
    transmissions: (event.transmissions ?? []).map((t) => ({ webhookUrl: t.webhook_url, httpStatus: t.http_status, status: t.status })),
  };
}
