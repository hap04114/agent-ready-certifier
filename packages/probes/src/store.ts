/**
 * Store-level security probes (sandbox only, scripted, read the store through its contract).
 * Each probe performs one small, non-destructive action and returns raw observations; the
 * truth checker decides. Paths default to the common PayPal integration layout
 * (/api/orders, /api/orders/:id/capture, /webhooks/paypal), which PayPal's own standard
 * example also uses.
 */
import { randomUUID } from "node:crypto";
import { TEST_HOOK_PATH, statusPath, storeOrderStatus } from "@certifier/contract";
import type { StoreRecordSnap } from "@certifier/truth";

export interface StoreTarget {
  url: string;
  statusKey: string;
  paths?: { createOrder?: string; capture?: (id: string) => string; webhook?: string; catalog?: string };
}

export interface ProbeDeps {
  fetcher?: typeof fetch;
  /** Called before each outgoing request (request budget). */
  spend?: () => void;
}

const paths = (t: StoreTarget) => ({
  createOrder: t.paths?.createOrder ?? "/api/orders",
  capture: t.paths?.capture ?? ((id: string) => `/api/orders/${encodeURIComponent(id)}/capture`),
  webhook: t.paths?.webhook ?? "/webhooks/paypal",
  catalog: t.paths?.catalog ?? "/api/catalog",
});

function client(t: StoreTarget, d: ProbeDeps) {
  const f = d.fetcher ?? fetch;
  const spend = d.spend ?? (() => {});
  return async (path: string, init: RequestInit = {}) => {
    spend();
    return f(new URL(path, t.url).toString(), { ...init, signal: AbortSignal.timeout(20_000) });
  };
}

export async function storeStatus(t: StoreTarget, d: ProbeDeps, paypalOrderId: string): Promise<StoreRecordSnap | undefined> {
  const res = await client(t, d)(statusPath(paypalOrderId), { headers: { authorization: `Bearer ${t.statusKey}` } });
  if (!res.ok) return undefined;
  const parsed = storeOrderStatus.safeParse(await res.json());
  return parsed.success ? parsed.data : undefined;
}

export interface CatalogItem {
  sku: string;
  price: string;
  currency: string;
}

export async function catalog(t: StoreTarget, d: ProbeDeps): Promise<CatalogItem[]> {
  const res = await client(t, d)(paths(t).catalog);
  if (!res.ok) return [];
  const body = (await res.json()) as { sku?: string; price?: string; currency?: string }[];
  return Array.isArray(body) ? body.filter((p) => p.sku && p.price).map((p) => ({ sku: p.sku!, price: p.price!, currency: p.currency ?? "USD" })) : [];
}

/** Create an order the normal way (as the store's page would). */
export async function createOrder(t: StoreTarget, d: ProbeDeps, body: Record<string, unknown>): Promise<{ status: number; id?: string }> {
  const res = await client(t, d)(paths(t).createOrder, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return { status: res.status, id: typeof json.id === "string" ? json.id : undefined };
}

export const TAMPER_VALUE = "1.00";
export const TAMPER_FIELDS = ["price", "amount", "unitPrice", "unit_amount", "total"];

/** S1: send a checkout request with every common price field set to a tiny amount. */
export async function probeS1(t: StoreTarget, d: ProbeDeps, item: CatalogItem) {
  const body: Record<string, unknown> = { sku: item.sku, quantity: 1 };
  for (const f of TAMPER_FIELDS) body[f] = TAMPER_VALUE;
  const res = await createOrder(t, d, body);
  return { ...res, rejected: res.status >= 400 && res.status < 500, tamperedFields: TAMPER_FIELDS, tamperedValue: TAMPER_VALUE };
}

/**
 * S2: a forged PAYMENT.CAPTURE.COMPLETED for an unpaid order, sent without a valid PayPal
 * signature (headers present but the signature is garbage and the cert URL is not PayPal's).
 */
export async function probeS2(t: StoreTarget, d: ProbeDeps, paypalOrderId: string, amount: { currencyCode: string; value: string }) {
  const event = {
    id: `WH-FORGED-${randomUUID()}`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource_type: "capture",
    resource: {
      id: `FORGED${Date.now()}`,
      status: "COMPLETED",
      amount: { currency_code: amount.currencyCode, value: amount.value },
      supplementary_data: { related_ids: { order_id: paypalOrderId } },
    },
  };
  const res = await client(t, d)(paths(t).webhook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paypal-transmission-id": randomUUID(),
      "paypal-transmission-time": new Date().toISOString(),
      "paypal-transmission-sig": Buffer.from("not-a-paypal-signature").toString("base64"),
      "paypal-cert-url": "https://certifier.invalid/forged-cert.pem",
      "paypal-auth-algo": "SHA256withRSA",
    },
    body: JSON.stringify(event),
  });
  return { sent: true, storeHttpStatus: res.status };
}

/** S4: ask the store to capture an already-captured order again. */
export async function probeS4(t: StoreTarget, d: ProbeDeps, paypalOrderId: string) {
  const res = await client(t, d)(paths(t).capture(paypalOrderId), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { secondCaptureHttpStatus: res.status };
}

/** S7: arm the contract test hook that makes the next checkout retry its order creation. */
export async function probeS7(t: StoreTarget, d: ProbeDeps, item: CatalogItem) {
  const arm = await client(t, d)(TEST_HOOK_PATH, {
    method: "POST",
    headers: { authorization: `Bearer ${t.statusKey}`, "content-type": "application/json" },
    body: JSON.stringify({ simulate: "create_retry" }),
  });
  if (arm.status !== 204) return { hookSupported: false as const };
  const res = await createOrder(t, d, { sku: item.sku, quantity: 1 });
  const status = res.id ? await storeStatus(t, d, res.id) : undefined;
  return { hookSupported: true as const, orderId: res.id, createAttempts: (status as { createAttempts?: string[] } | undefined)?.createAttempts };
}
