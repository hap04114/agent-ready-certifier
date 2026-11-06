/**
 * demo-store-good: a correct, current, secure PayPal checkout.
 * It is a *target* for the certifier, so it behaves like a merchant's own store:
 * - prices come from the server catalog only (S1)
 * - capture is refused for unknown or already-paid orders (S4)
 * - every PayPal call has a PayPal-Request-Id (via @certifier/paypal) (S7)
 * - CSP and HSTS headers on every response (S8)
 * - pay-later messaging next to the button (C2)
 * - GET /api/status/:paypalOrderId is the store-status endpoint the truth checker reads
 *
 * Milestone 2 adds the signed webhook handler and refund handling.
 * Store records are in memory for now; they reset when the process restarts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { z } from "zod";
import type { Config } from "@certifier/config";
import { PaypalCallError, captureIdsOf, type SandboxPaypal } from "@certifier/paypal";
import { CATALOG, CURRENCY, MAX_QUANTITY, centsToValue, findProduct, valueToCents } from "./catalog.js";

export type StoreOrderStatus = "created" | "paid" | "capture_failed";

export interface StoreOrder {
  paypalOrderId: string;
  sku: string;
  quantity: number;
  amountCents: number;
  currency: string;
  status: StoreOrderStatus;
  captureIds: string[];
  createdAt: string;
  paidAt?: string;
}

export interface StoreDeps {
  config: Config;
  paypal: Pick<SandboxPaypal, "createOrder" | "captureOrder">;
  /** Public sandbox client ID for the JS SDK. Not a secret, but never logged. */
  clientId: string;
  /** Request logging; tests turn it off. */
  logger?: boolean;
}

const PAYPAL_SOURCES = "https://*.paypal.com https://*.paypalobjects.com";
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    `script-src 'self' ${PAYPAL_SOURCES}`,
    `frame-src ${PAYPAL_SOURCES}`,
    `connect-src 'self' ${PAYPAL_SOURCES}`,
    `img-src 'self' data: ${PAYPAL_SOURCES}`,
    // The PayPal JS SDK injects inline styles for buttons and messages.
    `style-src 'self' 'unsafe-inline'`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const createBody = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.coerce.number().int().min(1).max(MAX_QUANTITY),
});
const orderIdParam = z.object({ id: z.string().regex(/^[A-Z0-9]{5,40}$/) });

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const checkoutJs = readFileSync(`${publicDir}checkout.js`, "utf8");
const pageTemplate = readFileSync(`${publicDir}index.html`, "utf8");

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function buildGoodStore(deps: StoreDeps) {
  const orders = new Map<string, StoreOrder>();
  const capturing = new Set<string>();
  const app = Fastify({ logger: deps.logger === false ? false : { redact: ["req.headers.authorization", "req.headers.cookie"] } });

  app.addHook("onSend", async (_req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
  });

  app.get("/", async (_req, reply) => {
    const sdkUrl = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(deps.clientId)}&currency=${CURRENCY}&components=buttons,messages&enable-funding=paylater`;
    const options = CATALOG.map(
      (p) => `<option value="${escapeHtml(p.sku)}" data-price="${centsToValue(p.priceCents)}">${escapeHtml(p.name)} — $${centsToValue(p.priceCents)}</option>`,
    ).join("");
    const first = CATALOG[0]!;
    const html = pageTemplate
      .replace("{{SDK_URL}}", escapeHtml(sdkUrl))
      .replace("{{OPTIONS}}", options)
      .replace("{{INITIAL_AMOUNT}}", centsToValue(first.priceCents));
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/checkout.js", async (_req, reply) => reply.type("application/javascript; charset=utf-8").send(checkoutJs));

  app.get("/api/catalog", async () =>
    CATALOG.map((p) => ({ sku: p.sku, name: p.name, price: centsToValue(p.priceCents), currency: CURRENCY, placeholder: true })),
  );

  app.post("/api/orders", async (req, reply) => {
    // Any "price" or "amount" the browser sends is ignored: only sku and quantity are read.
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const product = findProduct(parsed.data.sku);
    if (!product) return reply.code(404).send({ error: "unknown_sku" });

    const { quantity } = parsed.data;
    const amountCents = product.priceCents * quantity;
    const unit = { currencyCode: CURRENCY, value: centsToValue(product.priceCents) };
    try {
      const { order } = await deps.paypal.createOrder({
        amount: { currencyCode: CURRENCY, value: centsToValue(amountCents) },
        items: [{ name: product.name, sku: product.sku, quantity, unitAmount: unit }],
      });
      if (!order.id) return reply.code(502).send({ error: "paypal_no_order_id" });
      orders.set(order.id, {
        paypalOrderId: order.id,
        sku: product.sku,
        quantity,
        amountCents,
        currency: CURRENCY,
        status: "created",
        captureIds: [],
        createdAt: new Date().toISOString(),
      });
      return reply.code(201).send({ id: order.id });
    } catch (err) {
      return sendPaypalError(reply, err);
    }
  });

  app.post("/api/orders/:id/capture", async (req, reply) => {
    const params = orderIdParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_order_id" });
    const record = orders.get(params.data.id);
    if (!record) return reply.code(404).send({ error: "unknown_order" });
    if (record.status === "paid") return reply.code(409).send({ error: "already_captured" });
    if (capturing.has(record.paypalOrderId)) return reply.code(409).send({ error: "capture_in_progress" });

    capturing.add(record.paypalOrderId);
    try {
      const { order } = await deps.paypal.captureOrder(record.paypalOrderId);
      const capture = order.purchaseUnits?.[0]?.payments?.captures?.[0];
      const capturedCents = valueToCents(capture?.amount?.value);
      const ok =
        order.status === "COMPLETED" &&
        capture?.status === "COMPLETED" &&
        capturedCents === record.amountCents &&
        capture?.amount?.currencyCode === record.currency;

      record.captureIds = captureIdsOf(order);
      if (!ok) {
        record.status = "capture_failed";
        return reply.code(502).send({ error: "capture_not_completed", orderStatus: order.status, captureStatus: capture?.status });
      }
      record.status = "paid";
      record.paidAt = new Date().toISOString();
      return reply.send({ id: record.paypalOrderId, status: record.status, captureId: record.captureIds[0] });
    } catch (err) {
      return sendPaypalError(reply, err);
    } finally {
      capturing.delete(record.paypalOrderId);
    }
  });

  /** Store-side record for the truth checker: what this store believes happened. */
  app.get("/api/status/:id", async (req, reply) => {
    const params = orderIdParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_order_id" });
    const record = orders.get(params.data.id);
    if (!record) return reply.code(404).send({ error: "unknown_order" });
    return {
      paypalOrderId: record.paypalOrderId,
      status: record.status,
      amount: { currencyCode: record.currency, value: centsToValue(record.amountCents) },
      captureIds: record.captureIds,
      createdAt: record.createdAt,
      paidAt: record.paidAt ?? null,
    };
  });

  return { app, orders };
}

function sendPaypalError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof PaypalCallError) {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? 422 : 502;
    return reply.code(status).send({ error: "paypal_error", issues: err.issues, debugId: err.debugId });
  }
  throw err;
}
