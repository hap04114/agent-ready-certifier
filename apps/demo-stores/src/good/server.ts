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
import { CONTRACT_BASE, DELIVERY_HEADERS, OWNERSHIP_FILE_PATH, OWNERSHIP_META_NAME, TEST_HOOK_PATH, bearerMatches, testHookRequest } from "@certifier/contract";
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
  /** Public ownership token (store contract item 1), served as a meta tag and a file. */
  ownershipToken?: string;
  /** Base URL buyers see, used for PayPal return/cancel links. */
  publicUrl: string;
  /** Override signature verification in tests. */
  verifyWebhook?: WebhookVerifier;
  /** Request logging; tests turn it off. */
  logger?: boolean;
  /** Postgres schema for this store's records (default demo_store_good). */
  schema?: string;
  /** Store name shown on the page. */
  brand?: string;
  /**
   * SEEDED BUGS (demo-store-buggy only). Each one breaks exactly one certifier check, for the
   * accuracy benchmark. See docs/seeded-bugs.md. The good store runs with none.
   */
  bugs?: ReadonlySet<SeededBug>;
  /** Only with the expose_client_secret bug: the (sandbox, throwaway) secret it leaks. */
  exposedSecret?: string;
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

export const SEEDED_BUGS = [
  "refund_webhook_broken", // W4
  "trust_client_price", // S1
  "accept_unsigned_webhooks", // S2
  "no_webhook_dedup", // S3, W6
  "expose_client_secret", // S5
  "no_request_id_on_retry", // S7
  "no_security_headers", // S8
  "no_pay_later", // C2
  "agent_price_mismatch", // A4
  "unlabeled_controls", // A5
] as const;

/**
 * Schema.org Product + Offer JSON-LD for the catalog: the price AI shopping agents read.
 * SEEDED BUG agent_price_mismatch: a stale "sale" price (10% off) that checkout never charges.
 */
export function productJsonLd(stale: boolean): string {
  const graph = CATALOG.map((p) => ({
    "@type": "Product",
    sku: p.sku,
    name: p.name,
    offers: {
      "@type": "Offer",
      price: centsToValue(stale ? Math.round(p.priceCents * 0.9) : p.priceCents),
      priceCurrency: CURRENCY,
      availability: "https://schema.org/InStock",
    },
  }));
  // "<" is escaped so page data can never close the script element.
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}
export type SeededBug = (typeof SEEDED_BUGS)[number];

export function buildGoodStore(deps: StoreDeps) {
  const bugs = deps.bugs ?? new Set<SeededBug>();
  const has = (b: SeededBug) => bugs.has(b);
  const schema = deps.schema ?? "demo_store_good";
  const repoFor = (db: Db) => storeRepo(db, schema, { noWebhookDedup: has("no_webhook_dedup") });
  const repo = repoFor(deps.db);
  // S7 test hook: the next order creation behaves as if its first response was lost and retries.
  let simulateCreateRetryUntil = 0;
  const verify: WebhookVerifier =
    deps.verifyWebhook ??
    ((headers, rawBody) =>
      deps.webhookId
        ? verifyWebhook({ headers: webhookHeadersFrom(headers), rawBody, webhookId: deps.webhookId })
        : Promise.resolve({ valid: false, reason: "missing_headers" as const }));

  const app = Fastify({ logger: deps.logger === false ? false : { redact: ["req.headers.authorization", "req.headers.cookie"] } });

  app.addHook("onSend", async (_req, reply) => {
    if (has("no_security_headers")) return; // SEEDED BUG: no CSP, no HSTS
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
  });

  // ------------------------------------------------------------------ shop pages
  app.get("/", async (_req, reply) => {
    // SEEDED BUG no_pay_later: the SDK loads without the messages component and no placement.
    const sdkUrl = has("no_pay_later")
      ? `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(deps.clientId)}&currency=${CURRENCY}&components=buttons&enable-funding=venmo`
      : `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(deps.clientId)}&currency=${CURRENCY}&components=buttons,messages&enable-funding=paylater,venmo`;
    const options = CATALOG.map(
      (p) => `<option value="${escapeHtml(p.sku)}" data-price="${centsToValue(p.priceCents)}">${escapeHtml(p.name)} — $${centsToValue(p.priceCents)}</option>`,
    ).join("");
    const first = CATALOG[0]!;
    let html = pageTemplate
      .replace("{{SDK_URL}}", escapeHtml(sdkUrl))
      .replaceAll("{{BRAND}}", escapeHtml(deps.brand ?? "Demo Store"))
      .replace("{{OPTIONS}}", options)
      .replaceAll("{{INITIAL_AMOUNT}}", centsToValue(first.priceCents))
      .replace(
        "</head>",
        deps.ownershipToken ? `  <meta name="${OWNERSHIP_META_NAME}" content="${escapeHtml(deps.ownershipToken)}">
</head>` : "</head>",
      )
      .replace("</head>", `  <script type="application/ld+json">${productJsonLd(has("agent_price_mismatch"))}</script>\n</head>`);
    if (has("no_pay_later")) html = html.replace(/<div id="paylater"[^>]*><\/div>/, "");
    // SEEDED BUG unlabeled_controls: the captions look the same but are no longer <label>s tied
    // to their fields, so the product picker and quantity box have no accessible name.
    if (has("unlabeled_controls")) html = html.replace(/<label for="(sku|qty)">([^<]*)<\/label>/g, '<div class="label">$2</div>');
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get(OWNERSHIP_FILE_PATH, async (_req, reply) =>
    deps.ownershipToken ? reply.type("text/plain; charset=utf-8").send(deps.ownershipToken) : reply.code(404).send({ error: "no_ownership_token" }),
  );

  app.get("/checkout.js", async (_req, reply) => {
    // SEEDED BUG expose_client_secret: the bundle ships the app's client secret to every visitor.
    // The buggy store also sends the page price to the server (used by trust_client_price).
    const prefix = has("expose_client_secret")
      ? `window.STORE_CONFIG = { clientId: ${JSON.stringify(deps.clientId)}, clientSecret: ${JSON.stringify(deps.exposedSecret ?? "")}, sendPrice: ${has("trust_client_price")} };\n`
      : `window.STORE_CONFIG = { sendPrice: ${has("trust_client_price")} };\n`;
    return reply.type("application/javascript; charset=utf-8").send(prefix + checkoutJs);
  });

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
    // SEEDED BUG trust_client_price: a price sent by the browser overrides the catalog.
    const clientPrice = has("trust_client_price") ? valueToCents(String((req.body as { price?: unknown }).price ?? "")) : undefined;
    const unitCents = clientPrice ?? product.priceCents;
    const amountCents = unitCents * quantity;
    const unit = { currencyCode: CURRENCY, value: centsToValue(unitCents) };
    const create = (requestId: string) =>
      deps.paypal.createOrder({
        amount: { currencyCode: CURRENCY, value: centsToValue(amountCents) },
        items: [{ name: product.name, sku: product.sku, quantity, unitAmount: unit }],
        returnUrl: `${deps.publicUrl}/paypal/return`,
        cancelUrl: `${deps.publicUrl}/paypal/cancel`,
        requestId,
      });
    // A retry must reuse the PayPal-Request-Id so PayPal returns the same order instead of a
    // second one. SEEDED BUG no_request_id_on_retry: the buggy store makes a new ID each time.
    const requestId = randomUUID();
    const retryId = () => (has("no_request_id_on_retry") ? randomUUID() : requestId);
    try {
      const attempts: string[] = [];
      let result: Awaited<ReturnType<typeof create>>;
      try {
        result = await create(requestId);
      } catch (err) {
        if (!(err instanceof PaypalCallError) || (err.statusCode ?? 0) < 500) throw err;
        result = await create(retryId());
      }
      if (result.order.id) attempts.push(result.order.id);
      if (simulateCreateRetryUntil > Date.now()) {
        // Test hook: behave as if the first response was lost (a timeout) and retry.
        simulateCreateRetryUntil = 0;
        result = await create(retryId());
        if (result.order.id) attempts.push(result.order.id);
      }
      const { order } = result;
      if (!order.id) return reply.code(502).send({ error: "paypal_no_order_id" });
      await repo.insertOrder({ paypalOrderId: order.id, sku: product.sku, quantity, amountCents, currency: CURRENCY, createAttempts: attempts });
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
      // SEEDED BUG accept_unsigned_webhooks: the buggy store never checks PayPal's signature.
      const check = has("accept_unsigned_webhooks") ? { valid: true as const } : await verify(req.headers, raw);
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
          const txRepo = repoFor(tx);
          if (parsed.event_type === "PAYMENT.CAPTURE.COMPLETED" && r.id) {
            const order = relatedOrder ? await txRepo.getOrder(relatedOrder) : await txRepo.findByCapture(r.id);
            if (order && r.status === "COMPLETED" && valueToCents(r.amount?.value) === order.amount_cents && r.amount?.currency_code === order.currency) {
              await txRepo.markPaid(order.paypal_order_id, r.id);
              await txRepo.setEventOrder(parsed.id, order.paypal_order_id);
            }
          } else if (parsed.event_type === "PAYMENT.CAPTURE.REFUNDED" && r.id && !has("refund_webhook_broken")) {
            // (SEEDED BUG refund_webhook_broken: the buggy store acknowledges refunds but never records them.)
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
    if (parsed.success && "simulate" in parsed.data) {
      simulateCreateRetryUntil = Date.now() + 120_000;
      return reply.code(204).send();
    }
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!("mock" in parsed.data)) return reply.code(400).send({ error: "invalid_request" });
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
