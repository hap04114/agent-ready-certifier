import { ApiError, type Order } from "@paypal/paypal-server-sdk";
import { ConfigError, SANDBOX_API_BASE, parseConfig, type Config } from "@certifier/config";
import { describe, expect, it } from "vitest";
import { PaypalCallError, SandboxPaypal, type OrdersApi, type PaypalAuditEntry } from "./client.js";

const SECRET = "client-secret-must-not-leak-9876";
const config = parseConfig({
  PAYPAL_ENV: "sandbox",
  PAYPAL_API_BASE: SANDBOX_API_BASE,
  PAYPAL_CLIENT_ID: "client-id-value",
  PAYPAL_CLIENT_SECRET: SECRET,
});

type Call = { method: string; args: Record<string, unknown> };

function fakeOrders(behaviour: { capture?: () => Order; fail?: unknown } = {}) {
  const calls: Call[] = [];
  const respond = async (method: string, args: Record<string, unknown>, result: Order) => {
    calls.push({ method, args });
    if (behaviour.fail) throw behaviour.fail;
    return { result, statusCode: 201, headers: {}, request: {} as never, body: "" };
  };
  const orders = {
    createOrder: (args: Record<string, unknown>) => respond("createOrder", args, { id: "ORDER-1", status: "CREATED" } as Order),
    getOrder: (args: Record<string, unknown>) => respond("getOrder", args, { id: "ORDER-1", status: "APPROVED" } as Order),
    captureOrder: (args: Record<string, unknown>) =>
      respond(
        "captureOrder",
        args,
        behaviour.capture?.() ??
          ({ id: "ORDER-1", status: "COMPLETED", purchaseUnits: [{ payments: { captures: [{ id: "CAP-1", status: "COMPLETED" }] } }] } as Order),
      ),
  } as unknown as OrdersApi;
  return { orders, calls };
}

function fakeApiError(statusCode: number, result: unknown, headers: Record<string, string>): ApiError {
  const err = Object.create(ApiError.prototype) as ApiError;
  Object.assign(err, {
    statusCode,
    result,
    headers,
    message: "Response status code was not ok",
    // The real SDK error carries the request, including the bearer token.
    request: { headers: { Authorization: `Bearer ${SECRET}` } },
  });
  return err;
}

describe("SandboxPaypal", () => {
  it("refuses a non-sandbox config even if one were constructed by hand", () => {
    const tampered = { ...config, PAYPAL_API_BASE: "https://api-m.paypal.com" } as unknown as Config;
    expect(() => new SandboxPaypal(tampered, { orders: fakeOrders().orders })).toThrow(ConfigError);
  });

  it("requires client credentials to build the real SDK client", () => {
    const noCreds = parseConfig({ PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: SANDBOX_API_BASE });
    expect(() => new SandboxPaypal(noCreds)).toThrow(/PAYPAL_CLIENT_ID: is required for the PayPal client/);
  });

  it("sends a PayPal-Request-Id on create and capture, and returns it", async () => {
    const { orders, calls } = fakeOrders();
    const pp = new SandboxPaypal(config, { orders });
    const created = await pp.createOrder({ amount: { currencyCode: "USD", value: "24.00" } });
    const captured = await pp.captureOrder("ORDER-1");

    expect(created.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.requestId).not.toBe(captured.requestId);
    expect(calls[0]!.args.paypalRequestId).toBe(created.requestId);
    expect(calls[1]!.args.paypalRequestId).toBe(captured.requestId);
  });

  it("reuses a caller-supplied request ID (for retry-safety tests)", async () => {
    const { orders, calls } = fakeOrders();
    const pp = new SandboxPaypal(config, { orders });
    await pp.createOrder({ amount: { currencyCode: "USD", value: "1.00" }, requestId: "fixed-id" });
    await pp.createOrder({ amount: { currencyCode: "USD", value: "1.00" }, requestId: "fixed-id" });
    expect(calls.map((c) => c.args.paypalRequestId)).toEqual(["fixed-id", "fixed-id"]);
  });

  it("formats the negative-testing mock header", async () => {
    const { orders, calls } = fakeOrders();
    const pp = new SandboxPaypal(config, { orders });
    await pp.captureOrder("ORDER-1", { mock: "INSTRUMENT_DECLINED" });
    expect(calls[0]!.args.paypalMockResponse).toBe('{"mock_application_codes":"INSTRUMENT_DECLINED"}');
  });

  it("builds an item breakdown that matches the total", async () => {
    const { orders, calls } = fakeOrders();
    const pp = new SandboxPaypal(config, { orders });
    const amount = { currencyCode: "USD", value: "48.00" };
    await pp.createOrder({ amount, items: [{ name: "Mug", sku: "MUG", quantity: 2, unitAmount: { currencyCode: "USD", value: "24.00" } }] });
    const body = calls[0]!.args.body as { purchaseUnits: { amount: { breakdown: unknown }; items: { quantity: string }[] }[] };
    expect(body.purchaseUnits[0]!.amount.breakdown).toEqual({ itemTotal: amount });
    expect(body.purchaseUnits[0]!.items[0]!.quantity).toBe("2");
  });

  it("audits successful calls with IDs only", async () => {
    const audit: PaypalAuditEntry[] = [];
    const pp = new SandboxPaypal(config, { orders: fakeOrders().orders, audit: (e) => audit.push(e) });
    await pp.captureOrder("ORDER-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: "orders.capture", ok: true, orderId: "ORDER-1", orderStatus: "COMPLETED", captureIds: ["CAP-1"] });
  });

  it("turns SDK errors into safe errors without leaking the request or token", async () => {
    const audit: PaypalAuditEntry[] = [];
    const fail = fakeApiError(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }], debug_id: "dbg-1" }, { "PayPal-Debug-Id": "dbg-hdr" });
    const pp = new SandboxPaypal(config, { orders: fakeOrders({ fail }).orders, audit: (e) => audit.push(e) });

    const err = await pp.captureOrder("ORDER-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaypalCallError);
    expect(err).toMatchObject({ statusCode: 422, debugId: "dbg-hdr", issues: ["UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED"] });
    expect((err as Error).message).toBe("PayPal orders.capture failed with HTTP 422: UNPROCESSABLE_ENTITY, INSTRUMENT_DECLINED (debug id dbg-hdr)");
    expect("request" in (err as object)).toBe(false);

    expect(audit[0]).toMatchObject({ ok: false, statusCode: 422, debugId: "dbg-hdr" });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it("hides details of non-API errors", async () => {
    const fail = new Error(`connect failed using ${SECRET}`);
    const pp = new SandboxPaypal(config, { orders: fakeOrders({ fail }).orders });
    const err = await pp.getOrder("ORDER-1").catch((e: unknown) => e);
    expect((err as Error).message).toBe("PayPal orders.get failed: Error");
  });
});
