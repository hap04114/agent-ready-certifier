import { describe, expect, it } from "vitest";
import { type StorefrontObservation, judgeC1, judgeC2, judgeC3, judgeC4, judgeC5 } from "./current.js";
import { judgeS1, judgeS2, judgeS3, judgeS4, judgeS5, judgeS6, judgeS7, judgeS8 } from "./secure.js";
import type { PaypalOrderSnap, StoreRecordSnap } from "./types.js";

const usd = (value: string) => ({ currencyCode: "USD", value });
const order = (over: Partial<PaypalOrderSnap> = {}): PaypalOrderSnap => ({ id: "O1", status: "CREATED", amount: usd("50.00"), captures: [], ...over });
const captured = (n = 1) => order({ status: "COMPLETED", captures: Array.from({ length: n }, (_, i) => ({ id: `C${i}`, status: "COMPLETED", amount: usd("50.00") })) });
const store = (over: Partial<StoreRecordSnap> = {}): StoreRecordSnap => ({
  paypalOrderId: "O1",
  status: "created",
  amount: usd("50.00"),
  captureIds: [],
  refundIds: [],
  fulfilmentCount: 0,
  webhookEvents: [],
  ...over,
});

describe("S1 price tampering", () => {
  it("passes when PayPal charged the server price", () => {
    expect(judgeS1({ serverPrice: usd("50.00"), tamperedValue: "1.00", tamperedFields: ["price"], order: order() }).status).toBe("pass");
  });
  it("fails when PayPal charged the tampered price, with the order as evidence", () => {
    const r = judgeS1({ serverPrice: usd("50.00"), tamperedValue: "1.00", tamperedFields: ["price"], order: order({ amount: usd("1.00") }) });
    expect(r.status).toBe("fail");
    expect(r.reasons[0]).toMatch(/1.00 USD.*50.00 USD.*undercharged/);
    expect(r.evidence[0]).toMatchObject({ kind: "order", strength: "paypal-api" });
  });
  it("passes when the store rejects the tampered request; inconclusive without an order or price", () => {
    expect(judgeS1({ tamperedValue: "1.00", tamperedFields: [], storeRejected: true }).status).toBe("pass");
    expect(judgeS1({ serverPrice: usd("50.00"), tamperedValue: "1.00", tamperedFields: [] }).status).toBe("inconclusive");
    expect(judgeS1({ tamperedValue: "1.00", tamperedFields: [], order: order() }).status).toBe("inconclusive");
  });
});

describe("S2 forged webhook", () => {
  it("passes when nothing changed", () => {
    expect(judgeS2({ sent: true, storeHttpStatus: 400, before: store(), after: store(), order: order() }).status).toBe("pass");
  });
  it("fails when an unsigned event marked an uncaptured order paid", () => {
    const r = judgeS2({ sent: true, storeHttpStatus: 200, before: store(), after: store({ status: "paid", fulfilmentCount: 1 }), order: order() });
    expect(r.status).toBe("fail");
    expect(r.reasons).toContain("PayPal shows no capture for this order: the store would ship an unpaid order.");
  });
  it("is inconclusive when not sent or unobservable", () => {
    expect(judgeS2({ sent: false }).status).toBe("inconclusive");
    expect(judgeS2({ sent: true, before: store() }).status).toBe("inconclusive");
  });
});

describe("S3 webhook replay", () => {
  const ev = (processed: number) => ({ eventId: "E", type: "PAYMENT.CAPTURE.COMPLETED", deliveries: 2, processed });
  const dup = { eventId: "E", source: "certifier-replay" as const, signatureVerified: true };
  it("passes and fails with the security framing", () => {
    const before = store({ status: "paid", fulfilmentCount: 1, webhookEvents: [{ ...ev(1), deliveries: 1 }] });
    expect(judgeS3({ duplicates: [dup], before, after: store({ status: "paid", fulfilmentCount: 1, webhookEvents: [ev(1)] }) })).toMatchObject({ check: "S3", status: "pass" });
    const bad = judgeS3({ duplicates: [dup], before, after: store({ status: "paid", fulfilmentCount: 2, webhookEvents: [ev(2)] }) });
    expect(bad).toMatchObject({ check: "S3", status: "fail", summary: "A replayed event was processed again (replay attack)." });
  });
});

describe("S4 order replay", () => {
  it("passes when the second capture is refused", () => {
    expect(judgeS4({ secondCaptureHttpStatus: 409, order: captured(), before: store({ fulfilmentCount: 1 }), after: store({ fulfilmentCount: 1 }) }).status).toBe("pass");
  });
  it("fails on a second fulfilment or a reported success", () => {
    expect(judgeS4({ secondCaptureHttpStatus: 200, order: captured(), before: store({ fulfilmentCount: 1 }), after: store({ fulfilmentCount: 2 }) }).reasons).toHaveLength(2);
    expect(judgeS4({ order: captured(2), before: store(), after: store() }).status).toBe("fail");
  });
  it("is inconclusive without a captured order", () => {
    expect(judgeS4({ order: order(), before: store(), after: store() }).status).toBe("inconclusive");
  });
});

describe("S5 exposed secrets", () => {
  it("passes on a clean scan and fails with masked findings", () => {
    expect(judgeS5({ scanned: ["https://s/", "https://s/app.js"], findings: [] }).status).toBe("pass");
    const r = judgeS5({ scanned: ["https://s/app.js"], findings: [{ file: "https://s/app.js", kind: "client_secret", masked: "EOx…(80 chars)" }] });
    expect(r.status).toBe("fail");
    expect(r.evidence[0]).toMatchObject({ kind: "page", strength: "certifier-observed" });
  });
  it("is inconclusive when nothing could be scanned", () => {
    expect(judgeS5({ scanned: [], findings: [] }).status).toBe("inconclusive");
  });
});

describe("S6 sandbox/live mix-up", () => {
  it("passes on sandbox only and fails on live hosts or missing sandbox orders", () => {
    expect(judgeS6({ scanned: ["p"], liveHostHits: [], sandboxOrderId: "O1", sandboxOrderResolved: true }).status).toBe("pass");
    expect(judgeS6({ scanned: ["p"], liveHostHits: [{ file: "p", host: "api-m.paypal.com" }] }).status).toBe("fail");
    expect(judgeS6({ scanned: ["p"], liveHostHits: [], sandboxOrderId: "O1", sandboxOrderResolved: false }).status).toBe("fail");
    expect(judgeS6({ scanned: [], liveHostHits: [] }).status).toBe("inconclusive");
  });
});

describe("S7 retry safety", () => {
  it("passes when a retry reused the request ID and fails on duplicate PayPal orders", () => {
    expect(judgeS7({ hookSupported: true, createAttempts: ["O1", "O1"], resolved: [order()] }).status).toBe("pass");
    const r = judgeS7({ hookSupported: true, createAttempts: ["O1", "O2"], resolved: [order(), order({ id: "O2" })] });
    expect(r.status).toBe("fail");
    expect(r.reasons[0]).toMatch(/2 separate orders/);
  });
  it("is inconclusive without the hook, without a retry, or without PayPal confirmation", () => {
    expect(judgeS7({ hookSupported: false }).status).toBe("inconclusive");
    expect(judgeS7({ hookSupported: true, createAttempts: ["O1"] }).status).toBe("inconclusive");
    expect(judgeS7({ hookSupported: true, createAttempts: ["O1", "O2"], resolved: [] }).status).toBe("inconclusive");
  });
});

describe("S8 page hardening", () => {
  it("passes with CSP allowing PayPal and HSTS; fails otherwise", () => {
    expect(judgeS8({ url: "u", status: 200, csp: "script-src https://*.paypal.com", hsts: "max-age=1" }).status).toBe("pass");
    expect(judgeS8({ url: "u", status: 200 }).reasons).toEqual(["No Content-Security-Policy header.", "No Strict-Transport-Security (HSTS) header."]);
    expect(judgeS8({ url: "u", status: 200, csp: "default-src 'self'", hsts: "max-age=1" }).status).toBe("fail");
    expect(judgeS8({ url: "u" }).status).toBe("inconclusive");
  });
});

const obs = (over: Partial<StorefrontObservation> = {}): StorefrontObservation => ({
  url: "https://s/",
  fetched: true,
  sdk: { generation: "js-sdk", src: "https://www.paypal.com/sdk/js?client-id=x&components=buttons,messages", components: ["buttons", "messages"], enableFunding: ["paylater"] },
  payLaterMarkup: true,
  ...over,
});

describe("C1–C5 playbook", () => {
  it("C1 passes on the JS SDK or v6, fails on checkout.js", () => {
    expect(judgeC1(obs()).status).toBe("pass");
    expect(judgeC1(obs({ sdk: { generation: "web-sdk-v6", components: [], enableFunding: [] } })).status).toBe("pass");
    expect(judgeC1(obs({ sdk: { generation: "checkout.js", components: [], enableFunding: [] } })).status).toBe("fail");
    expect(judgeC1(obs({ sdk: { generation: "none", components: [], enableFunding: [] } })).status).toBe("inconclusive");
  });
  it("C2 needs the messages component and a placement (or a rendered message)", () => {
    expect(judgeC2(obs()).status).toBe("pass");
    expect(judgeC2(obs({ sdk: { generation: "js-sdk", components: ["buttons"], enableFunding: [] }, payLaterMarkup: false })).status).toBe("fail");
    expect(judgeC2(obs({ payLaterMarkup: false, rendered: { viewport: { width: 1, height: 1 }, payLaterMessageRendered: true } })).status).toBe("pass");
  });
  it("C3 compares the button position with the viewport", () => {
    expect(judgeC3(obs({ rendered: { viewport: { width: 1280, height: 800 }, paypalButton: { top: 400, bottom: 450 } } })).status).toBe("pass");
    expect(judgeC3(obs({ rendered: { viewport: { width: 1280, height: 800 }, paypalButton: { top: 1200, bottom: 1250 } } })).status).toBe("fail");
    expect(judgeC3(obs()).status).toBe("inconclusive");
  });
  it("C4 is not applicable unless saved methods are configured", () => {
    expect(judgeC4({ configured: false, url: "u" }).status).toBe("inconclusive");
    expect(judgeC4({ configured: true, offered: true, url: "u" }).status).toBe("pass");
  });
  it("C5 never fails a store for not offering Venmo", () => {
    expect(judgeC5(obs({ sdk: { generation: "js-sdk", components: [], enableFunding: ["venmo"] } })).status).toBe("pass");
    expect(judgeC5(obs({ sdk: { generation: "js-sdk", components: [], enableFunding: [] } })).status).toBe("inconclusive");
  });
});
