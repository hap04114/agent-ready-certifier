import { describe, expect, it } from "vitest";
import { sameMoney, toMinorUnits } from "./money.js";
import type { DeliverySnap, PaypalOrderSnap, SignedEventSnap, StoreRecordSnap } from "./types.js";
import { judgeW1, judgeW2, judgeW3, judgeW4, judgeW5, judgeW6 } from "./works.js";

const usd = (value: string) => ({ currencyCode: "USD", value });

const paidOrder = (over: Partial<PaypalOrderSnap> = {}): PaypalOrderSnap => ({
  id: "ORDER1",
  status: "COMPLETED",
  amount: usd("24.00"),
  captures: [{ id: "CAP1", status: "COMPLETED", amount: usd("24.00") }],
  ...over,
});
const approvedOrder = (): PaypalOrderSnap => ({ id: "ORDER2", status: "APPROVED", amount: usd("24.00"), captures: [] });

const store = (over: Partial<StoreRecordSnap> = {}): StoreRecordSnap => ({
  paypalOrderId: "ORDER1",
  status: "paid",
  amount: usd("24.00"),
  captureIds: ["CAP1"],
  refundIds: [],
  fulfilmentCount: 1,
  webhookEvents: [],
  ...over,
});

const signed = (over: Partial<SignedEventSnap> = {}): SignedEventSnap => ({
  eventId: "WH-1",
  type: "PAYMENT.CAPTURE.COMPLETED",
  resourceId: "CAP1",
  signatureValid: true,
  receivedAt: "2026-11-06T20:00:00Z",
  ...over,
});

const CERTIFIER_URL = "https://certifier.example/webhooks/paypal";
const delivery = (...storeStatuses: number[]): DeliverySnap => ({
  eventId: "WH-1",
  transmissions: [
    { webhookUrl: CERTIFIER_URL, httpStatus: 200, status: "SUCCESS" },
    ...storeStatuses.map((s) => ({ webhookUrl: "https://store.example/webhooks/paypal", httpStatus: s, status: s < 300 ? "SUCCESS" : "FAILURE" })),
  ],
});

describe("money", () => {
  it("compares minor units and currency", () => {
    expect(toMinorUnits("24.5")).toBe(2450);
    expect(toMinorUnits("1e2")).toBeUndefined();
    expect(sameMoney(usd("24.00"), usd("24"))).toBe(true);
    expect(sameMoney(usd("24.00"), { currencyCode: "EUR", value: "24.00" })).toBe(false);
    expect(sameMoney(usd("24.00"), undefined)).toBe(false);
  });
});

describe("W1 happy path", () => {
  it("passes when PayPal and store agree", () => {
    const v = judgeW1({ order: paidOrder(), store: store() });
    expect(v.status).toBe("pass");
    expect(v.evidence.map((e) => [e.kind, e.id, e.strength])).toEqual([
      ["order", "ORDER1", "paypal-api"],
      ["capture", "CAP1", "paypal-api"],
      ["store_record", "ORDER1", "store-reported"],
    ]);
  });

  it("is inconclusive without either record", () => {
    expect(judgeW1({ store: store() }).status).toBe("inconclusive");
    expect(judgeW1({ order: paidOrder() }).status).toBe("inconclusive");
  });

  it("fails when the order is not completed", () => {
    const v = judgeW1({ order: paidOrder({ status: "APPROVED", captures: [] }), store: store({ status: "created" }) });
    expect(v.status).toBe("fail");
    expect(v.reasons).toContain("PayPal shows no COMPLETED capture.");
  });

  it("fails when the store does not show paid", () => {
    expect(judgeW1({ order: paidOrder(), store: store({ status: "created" }) }).reasons).toContain('Store shows "created", expected "paid".');
  });

  it("fails on amount mismatch (store vs PayPal)", () => {
    const v = judgeW1({ order: paidOrder(), store: store({ amount: usd("1.00") }) });
    expect(v.status).toBe("fail");
    expect(v.reasons[0]).toMatch(/Store amount 1.00 USD differs from captured 24.00 USD/);
  });

  it("fails on duplicate captures", () => {
    const order = paidOrder({ captures: [{ id: "CAP1", status: "COMPLETED", amount: usd("24.00") }, { id: "CAP2", status: "COMPLETED", amount: usd("24.00") }] });
    expect(judgeW1({ order, store: store() }).reasons).toContain("PayPal shows 2 COMPLETED captures for one order (duplicate capture).");
  });

  it("fails when the store does not list the capture", () => {
    expect(judgeW1({ order: paidOrder(), store: store({ captureIds: [] }) }).reasons).toContain("Store does not list capture CAP1.");
  });
});

describe.each([
  ["W2", judgeW2],
  ["W3", judgeW3],
] as const)("%s forced error", (code, judge) => {
  it("passes when nothing was captured and the store is not paid", () => {
    const v = judge({ hookSupported: true, order: approvedOrder(), store: store({ status: "created", captureIds: [] }), storeCaptureHttpStatus: 422 });
    expect(v.check).toBe(code);
    expect(v.status).toBe("pass");
  });

  it("is inconclusive when the store has no test hook", () => {
    expect(judge({ hookSupported: false, order: approvedOrder(), store: store() }).status).toBe("inconclusive");
  });

  it("is inconclusive when records are unavailable", () => {
    expect(judge({ hookSupported: true, store: store() }).status).toBe("inconclusive");
    expect(judge({ hookSupported: true, order: approvedOrder() }).status).toBe("inconclusive");
  });

  it("is inconclusive when the mock was not applied and a real capture happened", () => {
    expect(judge({ hookSupported: true, order: paidOrder(), store: store() }).status).toBe("inconclusive");
  });

  it("fails when the store shows paid without a capture", () => {
    const v = judge({ hookSupported: true, order: approvedOrder(), store: store({ status: "paid", captureIds: [] }) });
    expect(v.status).toBe("fail");
    expect(v.reasons).toContain('Store shows "paid" although PayPal has no completed capture.');
  });

  it("fails when the store reports success to the buyer", () => {
    const v = judge({ hookSupported: true, order: approvedOrder(), store: store({ status: "created" }), storeCaptureHttpStatus: 200 });
    expect(v.status).toBe("fail");
  });

  it("fails on duplicate captures", () => {
    const order = paidOrder({ captures: [{ id: "A", status: "COMPLETED" }, { id: "B", status: "COMPLETED" }] });
    expect(judge({ hookSupported: true, order, store: store() }).status).toBe("fail");
  });
});

describe("W4 refund", () => {
  const refund = { id: "REF1", status: "COMPLETED", amount: usd("24.00") };
  const refundEvent = signed({ eventId: "WH-R", type: "PAYMENT.CAPTURE.REFUNDED", resourceId: "REF1" });

  it("passes when PayPal refunded and the store recorded it", () => {
    const v = judgeW4({ refund, refundEvent, store: store({ status: "refunded", refundIds: ["REF1"] }) });
    expect(v.status).toBe("pass");
    expect(v.evidence.find((e) => e.kind === "webhook_event")?.strength).toBe("paypal-signed");
  });

  it("fails when a signed refund event arrived but the store did not record it", () => {
    const v = judgeW4({ refund, refundEvent, store: store() });
    expect(v.status).toBe("fail");
  });

  it("is inconclusive when no verified refund event was observed (missing webhook)", () => {
    expect(judgeW4({ refund, store: store() }).status).toBe("inconclusive");
    expect(judgeW4({ refund, refundEvent: { ...refundEvent, signatureValid: false }, store: store() }).status).toBe("inconclusive");
  });

  it("is inconclusive while the refund is pending or unavailable", () => {
    expect(judgeW4({ refund: { ...refund, status: "PENDING" }, store: store() }).status).toBe("inconclusive");
    expect(judgeW4({ store: store() }).status).toBe("inconclusive");
    expect(judgeW4({ refund, refundEvent }).status).toBe("inconclusive");
  });

  it("requires the specific refund ID, not just a refunded status", () => {
    expect(judgeW4({ refund, refundEvent, store: store({ status: "refunded", refundIds: ["OTHER"] }) }).status).toBe("fail");
  });
});

describe("W5 webhook delivery", () => {
  it("passes when the signed event verifies and PayPal reports a 2xx from the store", () => {
    const v = judgeW5({ captureEvent: signed(), delivery: delivery(200), certifierWebhookUrl: CERTIFIER_URL });
    expect(v.status).toBe("pass");
    expect(v.evidence.map((e) => e.strength)).toEqual(["paypal-signed", "paypal-api"]);
  });

  it("passes on a later retry that succeeded", () => {
    expect(judgeW5({ captureEvent: signed(), delivery: delivery(500, 200), certifierWebhookUrl: CERTIFIER_URL }).status).toBe("pass");
  });

  it("fails when PayPal reports only non-2xx responses from the store", () => {
    const v = judgeW5({ captureEvent: signed(), delivery: delivery(500, 401), certifierWebhookUrl: CERTIFIER_URL });
    expect(v.status).toBe("fail");
    expect(v.reasons[0]).toBe("Store responses: 500, 401.");
  });

  it("does not count the certifier's own 2xx as the store's", () => {
    const onlyCertifier: DeliverySnap = { eventId: "WH-1", transmissions: [{ webhookUrl: CERTIFIER_URL, httpStatus: 200 }] };
    expect(judgeW5({ captureEvent: signed(), delivery: onlyCertifier, certifierWebhookUrl: CERTIFIER_URL }).status).toBe("inconclusive");
  });

  it("falls back to store-reported receipt when PayPal delivery data is unavailable", () => {
    const s = store({ webhookEvents: [{ eventId: "WH-1", type: "PAYMENT.CAPTURE.COMPLETED", deliveries: 1, processed: 1 }] });
    const v = judgeW5({ captureEvent: signed(), store: s });
    expect(v.status).toBe("pass");
    expect(v.summary).toMatch(/store reports/);
    expect(v.evidence.at(-1)?.strength).toBe("store-reported");
  });

  it("is inconclusive when the event is missing or unsigned", () => {
    expect(judgeW5({}).status).toBe("inconclusive");
    expect(judgeW5({ captureEvent: signed({ signatureValid: false }), delivery: delivery(200) }).status).toBe("inconclusive");
  });
});

describe("W6 duplicate delivery", () => {
  const before = store({ webhookEvents: [{ eventId: "WH-1", type: "PAYMENT.CAPTURE.COMPLETED", deliveries: 1, processed: 1 }] });
  const afterOk = store({ webhookEvents: [{ eventId: "WH-1", type: "PAYMENT.CAPTURE.COMPLETED", deliveries: 2, processed: 1 }] });

  it("passes when the duplicate was delivered and processed once", () => {
    expect(judgeW6({ eventId: "WH-1", resendRequested: true, before, after: afterOk }).status).toBe("pass");
  });

  it("accepts PayPal's delivery record as proof of the duplicate", () => {
    const after = store({ webhookEvents: [{ eventId: "WH-1", type: "x", deliveries: 1, processed: 1 }] });
    expect(judgeW6({ eventId: "WH-1", resendRequested: true, before, after, delivery: delivery(200, 200), certifierWebhookUrl: CERTIFIER_URL }).status).toBe("pass");
  });

  it("fails when the store processed the event twice", () => {
    const after = store({ fulfilmentCount: 2, webhookEvents: [{ eventId: "WH-1", type: "x", deliveries: 2, processed: 2 }] });
    const v = judgeW6({ eventId: "WH-1", resendRequested: true, before, after });
    expect(v.status).toBe("fail");
    expect(v.reasons).toEqual(["Store processed the event 2 times.", "Fulfilments changed from 1 to 2 after a duplicate event."]);
  });

  it("is inconclusive when the duplicate was not delivered or not requested", () => {
    expect(judgeW6({ eventId: "WH-1", resendRequested: true, before, after: before }).status).toBe("inconclusive");
    expect(judgeW6({ resendRequested: false, before, after: afterOk }).status).toBe("inconclusive");
    expect(judgeW6({ eventId: "WH-1", resendRequested: true, before }).status).toBe("inconclusive");
  });
});

describe("adapters", async () => {
  const { orderSnap, deliverySnap } = await import("./adapters.js");
  it("maps an Orders v2 record", () => {
    const snap = orderSnap({
      id: "O1",
      status: "COMPLETED",
      purchaseUnits: [{ amount: { currencyCode: "USD", value: "24.00" }, payments: { captures: [{ id: "C1", status: "COMPLETED", amount: { currencyCode: "USD", value: "24.00" } }] } }],
    });
    expect(snap).toEqual({ id: "O1", status: "COMPLETED", amount: usd("24.00"), captures: [{ id: "C1", status: "COMPLETED", amount: usd("24.00") }] });
  });
  it("maps delivery attempts", () => {
    expect(deliverySnap({ id: "E", transmissions: [{ webhook_url: "u", http_status: 200, status: "SUCCESS" }] })).toEqual({
      eventId: "E",
      transmissions: [{ webhookUrl: "u", httpStatus: 200, status: "SUCCESS" }],
    });
  });
});
