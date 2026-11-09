/**
 * demo-store-good: a correct, current, secure PayPal checkout.
 * It is a *target* for the certifier, so it behaves like a merchant's own store:
 * - prices come from the server catalog only (S1)
 * - capture is claimed atomically; already-paid orders are refused (S4)
 * - capture retries reuse the same PayPal-Request-Id (S7, W3)
 * - webhooks: PayPal signature verified, processed once per event ID (S2, S3, W5, W6)
 * - refunds recorded from the signed PAYMENT.CAPTURE.REFUNDED webhook (W4)
 * - CSP and HSTS headers on every response (S8); pay-later messaging (C2)
 * - store contract: status endpoint and optional sandbox test hook, behind a private status key
 *
 * Records live in Postgres (schema demo_store_good).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply } from "fastify";
import { z } from "zod";
import type { Config } from "@certifier/config";
import { CONTRACT_BASE, DELIVERY_HEADERS, TEST_HOOK_PATH, bearerMatches, testHookRequest } from "@certifier/contract";
import type { Db } from "@certifier/db";
import { PaypalCallError, type SandboxPaypal, type VerifyResult, captureIdsOf, verifyWebhook, webhookHeadersFrom } from "@certifier/paypal";
import { CATALOG, CURRENCY, MAX_QUANTITY, centsToValue, findProduct, valueToCents } from "./catalog.js";
import { storeRepo } from "./db.js";

export type WebhookVerifier = (headers: Record<string, string | string[] | undefined>, rawBody: Buffer) => Promise<VerifyResult>;

export interface StoreDeps {
  config: Config;
  db: Db;
  paypal: Pick<SandboxPaypal, "createOrder" | "captureOrder">;
  /** Public sandbox client ID for the JS SDK. Not a secret, but never logged. */
  clientId: string;
  /** The store's own webhook ID; without it the webhook endpoint refuses every event. */
  webhookId?: string;
  /** Private status key from the store contract; without it contract endpoints answer 503. */
  statusKey?: string;
  /** Base URL buyers see, used for PayPal return/cancel links. */
  publicUrl: string;
  /** Override signature verification in tests. */
  verifyWebhook?: WebhookVerifier;
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
const ORDER_ID = /^[A-Z0-9]{5,40}$/;
const orderIdParam = z.object({ id: z.string().regex(ORDER_ID) });

const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const checkoutJs = readFileSync(`${publicDir}checkout.js`, "utf8");
const pageTemplate = readFileSync(`${publicDir}index.html`, "utf8");

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Webhook payload fields the store reads. Everything else is ignored. */
const webhookEvent = z.object({
  id: z.string().min(1).max(100),
  event_type: z.string().min(1).max(100),
  resource_type: z.string().optional(),
  resource: z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
      supplementary_data: z.object({ related_ids: z.object({ order_id: z.string().optional() }).optional() }).optional(),
      links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
    })
    .passthrough(),
});

/** For a refund resource, the capture it belongs to is the `up` link. */
export function captureIdFromRefundLinks(links: { rel: string; href: string }[] | undefined): string | undefined {
  const up = links?.find((l) => l.rel === "up" && /\/v2\/payments\/captures\//.test(l.href));
  return up?.href.split("/captures/")[1]?.split(/[/?#]/)[0];
}

export function buildGoodStore(deps: StoreDeps) {
  const repo = storeRepo(deps.db);
  const verify: WebhookVerifier =
    deps.verifyWebhook ??
    ((headers, rawBody) =>
      deps.webhookId
        ? verifyWebhook({ headers: webhookHeadersFrom(headers), rawBody, webhookId: deps.webhookId })
        : Promise.resolve({ valid: false, reason: "missing_headers" as const }));

  const app = Fastify({ logger: deps.logger === false ? false : { redact: ["req.headers.authorization", "req.headers.cookie"] } });

  app.addHook("onSend", async (_req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
  });

  // ------------------------------------------------------------------ shop pages
  app.get("/", async (_req, reply) => {
    const sdkUrl = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(deps.clientId)}&currency=${CURRENCY}&components=buttons,messages&enable-funding=paylater`;
    const options = CATALOG.map(
      (p) => `<option value="${escapeHtml(p.sku)}" data-price="${centsToValue(p.priceCents)}">${escapeHtml(p.name)} — $${centsToValue(p.priceCents)}</option>`,
    ).join("");
    const first = CATALOG[0]!;
    const html = pageTemplate
      .replace("{{SDK_URL}}", escapeHtml(sdkUrl))
      .replace("{{OPTIONS}}", options)
      .replaceAll("{{INITIAL_AMOUNT}}", centsToValue(first.priceCents));
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/checkout.js", async (_req, reply) => reply.type("application/javascript; charset=utf-8").send(checkoutJs));

  app.get("/api/catalog", async () =>
    CATALOG.map((p) => ({ sku: p.sku, name: p.name, price: centsToValue(p.priceCents), currency: CURRENCY, placeholder: true })),
  );

  // ------------------------------------------------------------------ checkout
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
        returnUrl: `${deps.publicUrl}/paypal/return`,
        cancelUrl: `${deps.publicUrl}/paypal/cancel`,
      });
      if (!order.id) return reply.code(502).send({ error: "paypal_no_order_id" });
      await repo.insertOrder({ paypalOrderId: order.id, sku: product.sku, quantity, amountCents, currency: CURRENCY });
      return reply.code(201).send({ id: order.id });
    } catch (err) {
      return sendPaypalError(reply, err);
    }
  });

  /** Shared by the JS-SDK flow (POST) and the redirect flow (GET /paypal/return). */
  async function capture(id: string): Promise<{ http: number; body: Record<string, unknown> }> {
    const claim = await repo.claimForCapture(id, randomUUID());
    if (!claim) {
      const existing = await repo.getOrder(id);
      if (!existing) return { http: 404, body: { error: "unknown_order" } };
      if (existing.status === "paid" || existing.status === "refunded") return { http: 409, body: { error: "already_captured" } };
      return { http: 409, body: { error: "capture_in_progress" } };
    }
    const { row, mock } = claim;
    const attempt = () => deps.paypal.captureOrder(id, { requestId: row.capture_request_id!, mock: mock ?? undefined });
    try {
      let result: Awaited<ReturnType<typeof attempt>>;
      try {
        result = await attempt();
      } catch (err) {
        // One safe retry on a server error: same PayPal-Request-Id, so PayPal cannot capture twice.
        if (err instanceof PaypalCallError && (err.statusCode ?? 0) >= 500) result = await attempt();
        else throw err;
      }
      const { order } = result;
      const cap = order.purchaseUnits?.[0]?.payments?.captures?.[0];
      const ok =
        order.status === "COMPLETED" &&
        cap?.status === "COMPLETED" &&
        !!cap.id &&
        valueToCents(cap.amount?.value) === row.amount_cents &&
        cap.amount?.currencyCode === row.currency;
      if (!ok) {
        await repo.markCaptureFailed(id, { keepRequestId: false });
        return { http: 502, body: { error: "capture_not_completed", orderStatus: order.status, captureStatus: cap?.status } };
      }
      await repo.markPaid(id, cap.id!);
      return { http: 200, body: { id, status: "paid", captureId: captureIdsOf(order)[0] } };
    } catch (err) {
      // After a definite refusal (4xx) a later attempt needs a fresh PayPal-Request-Id, or PayPal
      // would replay the cached refusal. After a 5xx or network error the outcome is unknown, so
      // keep the same ID: a retry then returns the original result instead of capturing twice.
      const definite = err instanceof PaypalCallError && (err.statusCode ?? 0) >= 400 && (err.statusCode ?? 0) < 500;
      await repo.markCaptureFailed(id, { keepRequestId: !definite });
      if (err instanceof PaypalCallError) {
        const http = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? 422 : 502;
        return { http, body: { error: "paypal_error", issues: err.issues, debugId: err.debugId } };
      }
      throw err;
    }
  }

  app.post("/api/orders/:id/capture", async (req, reply) => {
    const params = orderIdParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_order_id" });
    const { http, body } = await capture(params.data.id);
    return reply.code(http).send(body);
  });

  /** Redirect flow: PayPal sends the buyer here after approval with ?token=<order id>. */
  app.get("/paypal/return", async (req, reply) => {
    const token = (req.query as { token?: string }).token ?? "";
    if (!ORDER_ID.test(token)) return reply.code(400).type("text/html").send(page("Invalid return link."));
    const { http, body } = await capture(token);
    const msg = http === 200 ? `Paid. PayPal order ${token}, capture ${String(body.captureId)}.` : `Payment not completed (${String(body.error)}).`;
    return reply.type("text/html; charset=utf-8").send(page(msg));
  });
  app.get("/paypal/cancel", async (_req, reply) => reply.type("text/html; charset=utf-8").send(page("Payment cancelled. Nothing was charged.")));

  // ------------------------------------------------------------------ webhooks
  app.register(async (scope) => {
    // Keep the exact bytes: the signature covers the raw body.
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.post("/webhooks/paypal", async (req, reply) => {
      const raw = req.body as Buffer;
      const check = await verify(req.headers, raw);
      if (!check.valid) {
        req.log.warn({ reason: check.reason }, "webhook rejected");
        return reply.code(400).send({ error: "invalid_signature" });
      }
      let parsed: z.infer<typeof webhookEvent>;
      try {
        parsed = webhookEvent.parse(JSON.parse(raw.toString("utf8")));
      } catch {
        return reply.code(400).send({ error: "invalid_event" });
      }
      // Keep the exact signed delivery (store contract item 4b).
      const keep: Record<string, string> = {};
      for (const h of DELIVERY_HEADERS) {
        const v = req.headers[h];
        if (typeof v === "string") keep[h] = v;
      }
      const deliveryId = await repo.recordDelivery({ eventId: parsed.id, transmissionId: keep["paypal-transmission-id"] ?? "unknown", headers: keep, rawBody: raw });

      const r = parsed.resource;
      const relatedOrder = r.supplementary_data?.related_ids?.order_id;
      const outcome = await repo.handleDelivery(
        { eventId: parsed.id, type: parsed.event_type, resourceId: r.id, paypalOrderId: relatedOrder },
        async (tx) => {
          const txRepo = storeRepo(tx);
          if (parsed.event_type === "PAYMENT.CAPTURE.COMPLETED" && r.id) {
            const order = relatedOrder ? await txRepo.getOrder(relatedOrder) : await txRepo.findByCapture(r.id);
            if (order && r.status === "COMPLETED" && valueToCents(r.amount?.value) === order.amount_cents && r.amount?.currency_code === order.currency) {
              await txRepo.markPaid(order.paypal_order_id, r.id);
              await txRepo.setEventOrder(parsed.id, order.paypal_order_id);
            }
          } else if (parsed.event_type === "PAYMENT.CAPTURE.REFUNDED" && r.id) {
            const captureId = captureIdFromRefundLinks(r.links);
            const order = captureId ? await txRepo.findByCapture(captureId) : undefined;
            if (order) {
              await txRepo.markRefunded(order.paypal_order_id, r.id);
              await txRepo.setEventOrder(parsed.id, order.paypal_order_id);
            }
          }
        },
      );
      // Demo-only fail-ack: processed above, but answer with an error once so PayPal retries.
      const orderId = await repo.eventOrder(parsed.id);
      const failAck = outcome === "processed" && orderId !== undefined && (await repo.consumeFailAck(orderId, parsed.event_type));
      const status = failAck ? 500 : 200;
      await repo.setDeliveryResponse(deliveryId, status);
      req.log.info({ eventId: parsed.id, type: parsed.event_type, outcome, failAck }, "webhook");
      return failAck ? reply.code(500).send({ error: "fail_ack_test_hook" }) : reply.code(200).send({ ok: true, outcome });
    });
  });

  // ------------------------------------------------------------------ store contract
  const authorized = (header: string | undefined) => bearerMatches(header, deps.statusKey);

  app.get(`${CONTRACT_BASE}/orders/:id`, async (req, reply) => {
    if (!deps.statusKey) return reply.code(503).send({ error: "status_key_not_configured" });
    if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const params = orderIdParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_order_id" });
    const status = await repo.status(params.data.id);
    return status ? reply.send(status) : reply.code(404).send({ error: "unknown_order" });
  });

  app.get(`${CONTRACT_BASE}/events/:eventId/deliveries`, async (req, reply) => {
    if (!deps.statusKey) return reply.code(503).send({ error: "status_key_not_configured" });
    if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    // Sandbox-only by construction: config refuses to boot unless PAYPAL_ENV=sandbox.
    if (deps.config.PAYPAL_ENV !== "sandbox") return reply.code(403).send({ error: "sandbox_only" });
    const params = z.object({ eventId: z.string().min(1).max(100) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_event_id" });
    // `since` is required: a run only sees deliveries received after it started.
    const q = z.object({ since: z.iso.datetime() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "since_required" });
    return reply.send({ eventId: params.data.eventId, deliveries: await repo.deliveries(params.data.eventId, new Date(q.data.since)) });
  });

  /** DEMO STORE ONLY (not part of the store contract): arm a one-time fail-ack. */
  app.post("/__demo/fail-ack", async (req, reply) => {
    if (!deps.statusKey) return reply.code(503).send({ error: "status_key_not_configured" });
    if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = z
      .object({ paypalOrderId: z.string().regex(ORDER_ID), eventType: z.enum(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED"]) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!(await repo.getOrder(parsed.data.paypalOrderId))) return reply.code(404).send({ error: "unknown_order" });
    await repo.armFailAck(parsed.data.paypalOrderId, parsed.data.eventType);
    return reply.code(204).send();
  });

  app.post(TEST_HOOK_PATH, async (req, reply) => {
    if (!deps.statusKey) return reply.code(503).send({ error: "status_key_not_configured" });
    if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
    // Sandbox-only by construction: config refuses to boot unless PAYPAL_ENV=sandbox.
    if (deps.config.PAYPAL_ENV !== "sandbox") return reply.code(403).send({ error: "sandbox_only" });
    const parsed = testHookRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const armed = await repo.armTestHook(parsed.data.paypalOrderId, parsed.data.mock);
    return armed ? reply.code(204).send() : reply.code(409).send({ error: "order_not_armable" });
  });

  return { app, repo };
}

function page(message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo Store</title></head><body style="font-family:system-ui;max-width:520px;margin:24px auto;padding:0 16px"><p>${escapeHtml(message)}</p><p><a href="/">Back to the store</a></p></body></html>`;
}

function sendPaypalError(reply: FastifyReply, err: unknown) {
  if (err instanceof PaypalCallError) {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? 422 : 502;
    return reply.code(status).send({ error: "paypal_error", issues: err.issues, debugId: err.debugId });
  }
  throw err;
}
