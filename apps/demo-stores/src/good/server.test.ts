import { SANDBOX_API_BASE, parseConfig } from "@certifier/config";
import { PaypalCallError, type CreateOrderInput, type Order } from "@certifier/paypal";
import { describe, expect, it } from "vitest";
import { centsToValue, valueToCents } from "./catalog.js";
import { SECURITY_HEADERS, buildGoodStore, type StoreDeps } from "./server.js";

const config = parseConfig({ PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: SANDBOX_API_BASE });

function fakePaypal(opts: { captureValue?: string; captureFails?: boolean } = {}) {
  const created: CreateOrderInput[] = [];
  let captures = 0;
  const paypal: StoreDeps["paypal"] = {
    async createOrder(input) {
      created.push(input);
      return { order: { id: `ORDER${created.length}ABC`, status: "CREATED" } as Order, requestId: "r" };
    },
    async captureOrder(id) {
      captures++;
      if (opts.captureFails) throw new PaypalCallError("orders.capture", 422, "dbg", ["UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED"]);
      const amount = created[0]!.amount;
      const order = {
        id,
        status: "COMPLETED",
        purchaseUnits: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currencyCode: amount.currencyCode, value: opts.captureValue ?? amount.value } }] } }],
      } as Order;
      return { order, requestId: "r" };
    },
  };
  return { paypal, created, captureCount: () => captures };
}

function store(opts?: Parameters<typeof fakePaypal>[0]) {
  const fake = fakePaypal(opts);
  const { app } = buildGoodStore({ config, paypal: fake.paypal, clientId: "public-client-id", logger: false });
  return { app, ...fake };
}

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

describe("demo-store-good", () => {
  it("prices orders from the server catalog and ignores a client-sent price (S1)", async () => {
    const { app, created } = store();
    const res = await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "LAMP-01", quantity: 2, price: "0.01", amount: "0.01" } });
    expect(res.statusCode).toBe(201);
    expect(created[0]!.amount).toEqual({ currencyCode: "USD", value: "100.00" });
    expect(created[0]!.items![0]!.unitAmount.value).toBe("50.00");
  });

  it("rejects unknown SKUs and bad quantities", async () => {
    const { app } = store();
    expect((await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "NOPE", quantity: 1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "MUG-01", quantity: 0 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "MUG-01", quantity: 999 } })).statusCode).toBe(400);
  });

  it("captures once, marks paid, and refuses a second capture (S4)", async () => {
    const { app, captureCount } = store();
    const { id } = (await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "MUG-01", quantity: 1 } })).json();
    const first = await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ id, status: "paid", captureId: "CAP1" });

    const second = await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    expect(second.statusCode).toBe(409);
    expect(captureCount()).toBe(1);

    const status = (await app.inject({ method: "GET", url: `/api/status/${id}` })).json();
    expect(status).toMatchObject({ paypalOrderId: id, status: "paid", amount: { currencyCode: "USD", value: "24.00" }, captureIds: ["CAP1"] });
  });

  it("does not mark paid when the captured amount differs", async () => {
    const { app } = store({ captureValue: "1.00" });
    const { id } = (await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "MUG-01", quantity: 1 } })).json();
    expect((await app.inject({ method: "POST", url: `/api/orders/${id}/capture` })).statusCode).toBe(502);
    expect((await app.inject({ method: "GET", url: `/api/status/${id}` })).json().status).toBe("capture_failed");
  });

  it("does not mark paid on a declined capture (W2 shape)", async () => {
    const { app } = store({ captureFails: true });
    const { id } = (await app.inject({ method: "POST", url: "/api/orders", payload: { sku: "MUG-01", quantity: 1 } })).json();
    const res = await app.inject({ method: "POST", url: `/api/orders/${id}/capture` });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "paypal_error", issues: ["UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED"], debugId: "dbg" });
    expect((await app.inject({ method: "GET", url: `/api/status/${id}` })).json().status).toBe("created");
  });

  it("refuses to capture orders it did not create", async () => {
    const { app, captureCount } = store();
    expect((await app.inject({ method: "POST", url: "/api/orders/SOMEONEELSE1/capture" })).statusCode).toBe(404);
    expect(captureCount()).toBe(0);
  });

  it("sends CSP and HSTS on every response (S8)", async () => {
    const { app } = store();
    for (const url of ["/", "/checkout.js", "/api/catalog", "/api/status/UNKNOWN1"]) {
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
