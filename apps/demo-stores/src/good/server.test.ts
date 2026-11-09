import { SANDBOX_API_BASE, parseConfig } from "@certifier/config";
import { TEST_HOOK_PATH, deliveriesPath, statusPath } from "@certifier/contract";
import type { Db } from "@certifier/db";
import { createTestDb } from "@certifier/db/testing";
import { type CallOptions, type CreateOrderInput, type Order, PaypalCallError } from "@certifier/paypal";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { centsToValue, valueToCents } from "./catalog.js";
import { SCHEMA, migrateStore } from "./db.js";
import { SECURITY_HEADERS, type StoreDeps, buildGoodStore, captureIdFromRefundLinks } from "./server.js";

const config = parseConfig({ PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: SANDBOX_API_BASE });
const KEY = "status-key-for-tests";
const auth = { authorization: `Bearer ${KEY}` };

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await migrateStore(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`TRUNCATE ${SCHEMA}.orders, ${SCHEMA}.webhook_events, ${SCHEMA}.webhook_deliveries, ${SCHEMA}.fail_ack`);
});

let orderSeq = 0;
function fakePaypal(opts: { captureValue?: string; fail?: PaypalCallError[] } = {}) {
  const created: CreateOrderInput[] = [];
  const captures: { id: string; options: CallOptions }[] = [];
  const failures = [...(opts.fail ?? [])];
  const paypal: StoreDeps["paypal"] = {
    async createOrder(input) {
      created.push(input);
      return { order: { id: `ORDER${++orderSeq}ABC`, status: "CREATED" } as Order, requestId: "r" };
    },
    async captureOrder(id, options = {}) {
      captures.push({ id, options });
      const next = failures.shift();
      if (next) throw next;
      const amount = created.at(-1)!.amount;
      const order = {
        id,
        status: "COMPLETED",
        purchaseUnits: [{ payments: { captures: [{ id: `CAP-${id}`, status: "COMPLETED", amount: { currencyCode: amount.currencyCode, value: opts.captureValue ?? amount.value } }] } }],
      } as Order;
      return { order, requestId: options.requestId ?? "r" };
    },
  };
  return { paypal, created, captures };
}

function store(opts: Parameters<typeof fakePaypal>[0] & { signatureValid?: boolean; statusKey?: string | null } = {}) {
  const fake = fakePaypal(opts);
  const { app, repo } = buildGoodStore({
    config,
    db,
    paypal: fake.paypal,
    clientId: "public-client-id",
    statusKey: opts.statusKey === null ? undefined : (opts.statusKey ?? KEY),
    publicUrl: "http://localhost:5001",
    verifyWebhook: async () => (opts.signatureValid === false ? { valid: false, reason: "bad_signature" } : { valid: true }),
    logger: false,
  });
  return { app, repo, ...fake };
}

async function newOrder(app: ReturnType<typeof store>["app"], sku = "MUG-01", quantity = 1): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/orders", payload: { sku, quantity } });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}
const status = async (app: ReturnType<typeof store>["app"], id: string) => (await app.inject({ method: "GET", url: statusPath(id), headers: auth })).json();

function webhook(app: ReturnType<typeof store>["app"], event: Record<string, unknown>, transmissionId = "TX-1") {
  return app.inject({
    method: "POST",
    url: "/webhooks/paypal",
    headers: { "content-type": "application/json", "paypal-transmission-id": transmissionId, "paypal-transmission-sig": "c2ln", "x-other": "dropped" },
    payload: JSON.stringify(event),
  });
}
const captureEvent = (eventId: string, orderId: string, value = "24.00") => ({
  id: eventId,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource_type: "capture",
  resource: { id: `CAP-${orderId}`, status: "COMPLETED", amount: { currency_code: "USD", value }, supplementary_data: { related_ids: { order_id: orderId } } },
});
const refundEvent = (eventId: string, captureId: string, refundId = "REF-1") => ({
  id: eventId,
  event_type: "PAYMENT.CAPTURE.REFUNDED",
  resource_type: "refund",
  resource: {
    id: refundId,
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "24.00" },
    links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }],
  },
});

describe("catalog money helpers", () => {
  it("round-trips cents", () => {
    expect(centsToValue(2400)).toBe("24.00");
    expect(centsToValue(5)).toBe("0.05");
    expect(valueToCents("24.00")).toBe(2400);
    expect(valueToCents("24.5")).toBe(2450);
    expect(valueToCents("1e3")).toBeUndefined();
    expect(valueToCents("-1.00")).toBeUndefined();
  });
});

describe("checkout", () => {
  it("prices orders from the server catalog and ignores a client-sent price (S1)", async () => {
    const { app, created } = store();
    const res = await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "LAMP-01", quantity: 2, price: "0.01", amount: "0.01" } });
    expect(res.statusCode).toBe(201);
    expect(created[0]!.amount).toEqual({ currencyCode: "USD", value: "100.00" });
    expect(created[0]!.items![0]!.unitAmount.value).toBe("50.00");
    expect(created[0]!.returnUrl).toBe("http://localhost:5001/paypal/return");
  });

  it("rejects unknown SKUs and bad quantities", async () => {
    const { app } = store();
    expect((await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "NOPE", quantity: 1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "MUG-01", quantity: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "MUG-01", quantity: 999 } })).statusCode).toBe(400);
  });

  it("captures once, persists paid, fulfils once and refuses a second capture (S4)", async () => {
    const { app, captures } = store();
    const id = await newOrder(app);
    const first = await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ id, status: "paid", captureId: `CAP-${id}` });
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/capture` })).statusCode).toBe(409);
    expect(captures).toHaveLength(1);
    expect(await status(app, id)).toMatchObject({ status: "paid", amount: { currencyCode: "USD", value: "24.00" }, captureIds: [`CAP-${id}`], fulfilmentCount: 1 });
  });

  it("captures through the redirect return page too", async () => {
    const { app } = store();
    const id = await newOrder(app);
    const res = await app.inject({ method: "GET", url: `/paypal/return?token=${id}&PayerID=X` });
    expect(res.body).toContain(`Paid. PayPal order ${id}`);
    expect((await status(app, id)).status).toBe("paid");
  });

  it("does not mark paid when the captured amount differs", async () => {
    const { app } = store({ captureValue: "1.00" });
    const id = await newOrder(app);
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/capture` })).statusCode).toBe(502);
    expect((await status(app, id)).status).toBe("capture_failed");
  });

  it("does not mark paid on a decline, and a later attempt uses a fresh request ID (W2)", async () => {
    const { app, captures } = store({ fail: [new PaypalCallError("orders.capture", 422, "dbg", ["UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED"])] });
    const id = await newOrder(app);
    const res = await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "paypal_error", issues: ["UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED"], debugId: "dbg" });
    expect((await status(app, id)).status).toBe("capture_failed");

    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/capture` })).statusCode).toBe(200);
    expect(captures[1]!.options.requestId).not.toBe(captures[0]!.options.requestId);
  });

  it("retries a server error once with the SAME request ID (W3, S7)", async () => {
    const err = () => new PaypalCallError("orders.capture", 500, "dbg", ["INTERNAL_SERVER_ERROR"]);
    const { app, captures } = store({ fail: [err(), err()] });
    const id = await newOrder(app);
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/capture` })).statusCode).toBe(502);
    expect(captures).toHaveLength(2);
    expect(captures[0]!.options.requestId).toBe(captures[1]!.options.requestId);
    expect((await status(app, id)).status).toBe("capture_failed");

    // The outcome was unknown, so the next attempt keeps the same ID as well.
    await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    expect(captures[2]!.options.requestId).toBe(captures[0]!.options.requestId);
  });

  it("refuses to capture orders it did not create", async () => {
    const { app, captures } = store();
    expect((await app.inject({ method: "POST", url: "/api/orders/SOMEONEELSE1/capture" })).statusCode).toBe(404);
    expect(captures).toHaveLength(0);
  });
});

describe("store contract", () => {
  it("requires the status key", async () => {
    const { app } = store();
    const id = await newOrder(app);
    expect((await app.inject({ method: "GET", url: statusPath(id) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: statusPath(id), headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: statusPath(id), headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: statusPath("UNKNOWN1"), headers: auth })).statusCode).toBe(404);
  });

  it("answers 503 when no status key is configured", async () => {
    const { app } = store({ statusKey: null });
    expect((await app.inject({ method: "GET", url: statusPath("ORDER1"), headers: auth })).statusCode).toBe(503);
  });

  it("test hook forwards the armed mock code to PayPal once (W2/W3)", async () => {
    const { app, captures } = store();
    const id = await newOrder(app);
    const arm = await app.inject({ method: "POST", url: TEST_HOOK_PATH, headers: auth, payload: { paypalOrderId: id, mock: "INSTRUMENT_DECLINED" } });
    expect(arm.statusCode).toBe(204);
    await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    expect(captures[0]!.options.mock).toBe("INSTRUMENT_DECLINED");
  });

  it("test hook refuses bad codes, unknown or settled orders, and missing keys", async () => {
    const { app } = store();
    const id = await newOrder(app);
    expect((await app.inject({ method: "POST", url: TEST_HOOK_PATH, payload: { paypalOrderId: id, mock: "INSTRUMENT_DECLINED" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: TEST_HOOK_PATH, headers: auth, payload: { paypalOrderId: id, mock: "ANYTHING" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: TEST_HOOK_PATH, headers: auth, payload: { paypalOrderId: "UNKNOWN1", mock: "INSTRUMENT_DECLINED" } })).statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    expect((await app.inject({ method: "POST", url: TEST_HOOK_PATH, headers: auth, payload: { paypalOrderId: id, mock: "INSTRUMENT_DECLINED" } })).statusCode).toBe(409);
  });
});

describe("webhooks", () => {
  it("rejects events whose signature does not verify (S2)", async () => {
    const { app } = store({ signatureValid: false });
    const id = await newOrder(app);
    expect((await webhook(app, captureEvent("WH-1", id))).statusCode).toBe(400);
    expect((await status(app, id)).status).toBe("created");
  });

  it("marks paid from a signed capture event and processes a duplicate only once (W5, W6, S3)", async () => {
    const { app } = store();
    const id = await newOrder(app);
    expect((await webhook(app, captureEvent("WH-1", id))).json()).toEqual({ ok: true, outcome: "processed" });
    expect((await webhook(app, captureEvent("WH-1", id))).json()).toEqual({ ok: true, outcome: "duplicate" });
    const s = await status(app, id);
    expect(s).toMatchObject({ status: "paid", fulfilmentCount: 1 });
    expect(s.webhookEvents).toEqual([{ eventId: "WH-1", type: "PAYMENT.CAPTURE.COMPLETED", deliveries: 2, processed: 1 }]);
  });

  it("does not fulfil twice when the capture response and the webhook both arrive", async () => {
    const { app } = store();
    const id = await newOrder(app);
    await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    await webhook(app, captureEvent("WH-2", id));
    expect((await status(app, id)).fulfilmentCount).toBe(1);
  });

  it("handles concurrent duplicate deliveries without double processing", async () => {
    const { app } = store();
    const id = await newOrder(app);
    const results = await Promise.all([1, 2, 3].map(() => webhook(app, captureEvent("WH-C", id))));
    expect(results.map((r) => r.json().outcome).sort()).toEqual(["duplicate", "duplicate", "processed"]);
    expect((await status(app, id)).webhookEvents[0]).toMatchObject({ deliveries: 3, processed: 1 });
  });

  it("ignores a capture event whose amount does not match the order", async () => {
    const { app } = store();
    const id = await newOrder(app);
    await webhook(app, captureEvent("WH-3", id, "1.00"));
    expect((await status(app, id)).status).toBe("created");
  });

  it("records a refund from a signed refund event (W4)", async () => {
    const { app } = store();
    const id = await newOrder(app);
    await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    await webhook(app, refundEvent("WH-R", `CAP-${id}`, "REF-9"));
    const s = await status(app, id);
    expect(s).toMatchObject({ status: "refunded", refundIds: ["REF-9"] });
    expect(s.webhookEvents.map((e: { eventId: string }) => e.eventId)).toContain("WH-R");
  });

  it("finds the capture ID in a refund's up link", () => {
    expect(captureIdFromRefundLinks([{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/3C679366HH908993F" }])).toBe("3C679366HH908993F");
    expect(captureIdFromRefundLinks([{ rel: "self", href: "https://x/v2/payments/refunds/R1" }])).toBeUndefined();
  });
});

describe("delivery log and fail-ack (W6)", () => {
  const T0 = new Date(Date.now() - 60_000);

  it("requires `since` and returns only deliveries from the current run", async () => {
    const { app } = store();
    const id = await newOrder(app);
    await webhook(app, captureEvent("WH-S", id), "TX-S");
    expect((await app.inject({ method: "GET", url: "/.well-known/certifier/events/WH-S/deliveries", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: deliveriesPath("WH-S", new Date(Date.now() + 60_000)), headers: auth })).json().deliveries).toEqual([]);
    expect((await app.inject({ method: "GET", url: deliveriesPath("WH-S", T0), headers: auth })).json().deliveries).toHaveLength(1);
  });

  it("drops deliveries older than the retention window", async () => {
    const { app } = store();
    const id = await newOrder(app);
    await webhook(app, captureEvent("WH-OLD", id), "TX-OLD");
    await db.query(`UPDATE ${SCHEMA}.webhook_deliveries SET received_at = now() - interval '25 hours' WHERE event_id = 'WH-OLD'`);
    await webhook(app, captureEvent("WH-NEW", id), "TX-NEW");
    expect((await db.query(`SELECT event_id FROM ${SCHEMA}.webhook_deliveries ORDER BY id`)).rows).toEqual([{ event_id: "WH-NEW" }]);
  });

  it("keeps each accepted delivery byte for byte, behind the status key", async () => {
    const { app } = store();
    const id = await newOrder(app);
    const event = captureEvent("WH-L", id);
    await webhook(app, event, "TX-A");
    expect((await app.inject({ method: "GET", url: deliveriesPath("WH-L", T0) })).statusCode).toBe(401);
    const res = (await app.inject({ method: "GET", url: deliveriesPath("WH-L", T0), headers: auth })).json();
    expect(res.deliveries).toHaveLength(1);
    const d = res.deliveries[0];
    expect(Buffer.from(d.bodyBase64, "base64").toString()).toBe(JSON.stringify(event));
    expect(d.headers).toEqual({ "paypal-transmission-id": "TX-A", "paypal-transmission-sig": "c2ln" });
    expect(d).toMatchObject({ transmissionId: "TX-A", responseStatus: 200 });
  });

  it("does not log deliveries whose signature fails", async () => {
    const { app } = store({ signatureValid: false });
    const id = await newOrder(app);
    await webhook(app, captureEvent("WH-X", id));
    expect((await app.inject({ method: "GET", url: deliveriesPath("WH-X", T0), headers: auth })).json().deliveries).toEqual([]);
  });

  it("fail-ack processes the refund, answers 500 once, then treats PayPal's retry as a duplicate", async () => {
    const { app } = store();
    const id = await newOrder(app);
    await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    const arm = await app.inject({ method: "POST", url: "/__demo/fail-ack", headers: auth, payload: { paypalOrderId: id, eventType: "PAYMENT.CAPTURE.REFUNDED" } });
    expect(arm.statusCode).toBe(204);

    const first = await webhook(app, refundEvent("WH-RF", `CAP-${id}`, "REF-1"), "TX-1");
    expect(first.statusCode).toBe(500);
    expect((await status(app, id)).status).toBe("refunded");

    const retry = await webhook(app, refundEvent("WH-RF", `CAP-${id}`, "REF-1"), "TX-2");
    expect(retry.json()).toEqual({ ok: true, outcome: "duplicate" });
    const s = await status(app, id);
    expect(s.refundIds).toEqual(["REF-1"]);
    expect(s.webhookEvents.find((e: { eventId: string }) => e.eventId === "WH-RF")).toMatchObject({ deliveries: 2, processed: 1 });
    const log = (await app.inject({ method: "GET", url: deliveriesPath("WH-RF", T0), headers: auth })).json().deliveries;
    expect(log.map((x: { transmissionId: string; responseStatus: number }) => [x.transmissionId, x.responseStatus])).toEqual([["TX-1", 500], ["TX-2", 200]]);
  });

  it("fail-ack hook needs the status key and a known order", async () => {
    const { app } = store();
    expect((await app.inject({ method: "POST", url: "/__demo/fail-ack", payload: { paypalOrderId: "ORDER1", eventType: "PAYMENT.CAPTURE.REFUNDED" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/__demo/fail-ack", headers: auth, payload: { paypalOrderId: "UNKNOWN1", eventType: "PAYMENT.CAPTURE.REFUNDED" } })).statusCode).toBe(404);
  });
});

describe("page", () => {
  it("sends CSP and HSTS on every response (S8)", async () => {
    const { app } = store();
    for (const url of ["/", "/checkout.js", "/api/catalog", statusPath("UNKNOWN1")]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["content-security-policy"]).toBe(SECURITY_HEADERS["content-security-policy"]);
      expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    }
  });

  it("renders the current JS SDK with pay-later messaging and no secrets (C1, C2, S5)", async () => {
    const { app } = store();
    const html = (await app.inject({ method: "GET", url: "/" })).body;
    expect(html).toContain("https://www.paypal.com/sdk/js?client-id=public-client-id");
    expect(html).toContain("components=buttons,messages");
    expect(html).toContain("data-pp-message");
    expect(html).not.toContain("paypalobjects.com/api/checkout.js");
    expect(html).not.toMatch(/sandbox\.paypal\.com|client_secret|access_token/i);
  });
});
