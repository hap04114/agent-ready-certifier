import { SANDBOX_API_BASE, parseConfig } from "@certifier/config";
import { TEST_HOOK_PATH, statusPath } from "@certifier/contract";
import type { Db } from "@certifier/db";
import { createTestDb } from "@certifier/db/testing";
import type { Order } from "@certifier/paypal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateStore } from "./db.js";
import { SEEDED_BUGS, type SeededBug, type StoreDeps, buildGoodStore } from "./server.js";

const config = parseConfig({ PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: SANDBOX_API_BASE });
const KEY = "status-key";
const auth = { authorization: `Bearer ${KEY}` };
const LEAKED = "EThIsIsAsAnDbOxSeCrEtThAtThEbUgGyStOrElEaKs0123456789abcdefghijklmnopqrstuv";

let db: Db;
let ALL: ReturnType<typeof make>;
let GOOD: ReturnType<typeof make>;
beforeAll(async () => {
  db = await createTestDb();
  await migrateStore(db, "demo_store_good");
  await migrateStore(db, "demo_store_buggy");
  ALL = make([...SEEDED_BUGS]);
  GOOD = make([]);
});
afterAll(() => db.close());

/** A fake PayPal that, like the real one, returns the SAME order for a reused PayPal-Request-Id. */
function fakePaypal() {
  const byRequestId = new Map<string, string>();
  let seq = 0;
  const amounts = new Map<string, string>();
  const paypal: StoreDeps["paypal"] = {
    async createOrder(input) {
      const rid = input.requestId ?? `none-${seq}`;
      let id = byRequestId.get(rid);
      if (!id) {
        id = `ORDER${++seq}X${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        byRequestId.set(rid, id);
        amounts.set(id, input.amount.value);
      }
      return { order: { id, status: "CREATED" } as Order, requestId: rid };
    },
    async captureOrder(id, options = {}) {
      const value = amounts.get(id) ?? "0.00";
      const order = { id, status: "COMPLETED", purchaseUnits: [{ payments: { captures: [{ id: `CAP-${id}`, status: "COMPLETED", amount: { currencyCode: "USD", value } }] } }] } as Order;
      return { order, requestId: options.requestId ?? "r" };
    },
  };
  return { paypal, amounts };
}

function make(bugs: SeededBug[]) {
  const fake = fakePaypal();
  const buggy = bugs.length > 0;
  const { app } = buildGoodStore({
    config,
    db,
    schema: buggy ? "demo_store_buggy" : "demo_store_good",
    bugs: new Set(bugs),
    exposedSecret: LEAKED,
    paypal: fake.paypal,
    clientId: "public-client-id",
    statusKey: KEY,
    publicUrl: "http://localhost",
    // Signature check always fails here: only a store that skips it will accept events.
    verifyWebhook: async () => ({ valid: false, reason: "bad_signature" }),
    logger: false,
  });
  return { app, ...fake };
}

const newOrder = async (app: ReturnType<typeof make>["app"], body: Record<string, unknown> = { sku: "LAMP-01", quantity: 1 }) =>
  (await app.inject({ method: "POST", url: "/api/orders", payload: body })).json().id as string;
const status = async (app: ReturnType<typeof make>["app"], id: string) => (await app.inject({ method: "GET", url: statusPath(id), headers: auth })).json();
const event = (id: string, type: string, orderId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, event_type: type, resource: { id: `CAP-${orderId}`, status: "COMPLETED", amount: { currency_code: "USD", value: "50.00" }, supplementary_data: { related_ids: { order_id: orderId } }, ...extra } });
const post = (app: ReturnType<typeof make>["app"], body: string) =>
  app.inject({ method: "POST", url: "/webhooks/paypal", headers: { "content-type": "application/json", "paypal-transmission-id": "tx" }, payload: body });

describe("seeded bugs (demo-store-buggy) vs the good store", () => {
  it("trust_client_price: the buggy store charges the browser's price (S1)", async () => {
    const id = await newOrder(ALL.app, { sku: "LAMP-01", quantity: 1, price: "1.00" });
    expect(ALL.amounts.get(id)).toBe("1.00");
    const good = await newOrder(GOOD.app, { sku: "LAMP-01", quantity: 1, price: "1.00" });
    expect(GOOD.amounts.get(good)).toBe("50.00");
  });

  it("accept_unsigned_webhooks: the buggy store marks an order paid on an unsigned event (S2)", async () => {
    const id = await newOrder(ALL.app);
    expect((await post(ALL.app, event("WH-F1", "PAYMENT.CAPTURE.COMPLETED", id))).statusCode).toBe(200);
    expect((await status(ALL.app, id)).status).toBe("paid");
    const good = await newOrder(GOOD.app);
    expect((await post(GOOD.app, event("WH-F2", "PAYMENT.CAPTURE.COMPLETED", good))).statusCode).toBe(400);
    expect((await status(GOOD.app, good)).status).toBe("created");
  });

  it("no_webhook_dedup: a duplicate event is processed again and ships twice (S3, W6)", async () => {
    const id = await newOrder(ALL.app);
    await post(ALL.app, event("WH-D1", "PAYMENT.CAPTURE.COMPLETED", id));
    await post(ALL.app, event("WH-D1", "PAYMENT.CAPTURE.COMPLETED", id));
    const s = await status(ALL.app, id);
    expect(s.webhookEvents[0]).toMatchObject({ deliveries: 2, processed: 2 });
    expect(s.fulfilmentCount).toBe(2);
  });

  it("refund_webhook_broken: a refund event is acknowledged but never recorded (W4)", async () => {
    const id = await newOrder(ALL.app);
    await post(ALL.app, event("WH-P", "PAYMENT.CAPTURE.COMPLETED", id));
    const refund = JSON.stringify({
      id: "WH-R",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: { id: "REF-1", status: "COMPLETED", links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/CAP-${id}` }] },
    });
    expect((await post(ALL.app, refund)).statusCode).toBe(200);
    expect((await status(ALL.app, id)).status).toBe("paid");
  });

  it("expose_client_secret: the buggy bundle ships the secret; the good one does not (S5)", async () => {
    expect((await ALL.app.inject({ method: "GET", url: "/checkout.js" })).body).toContain(LEAKED);
    expect((await GOOD.app.inject({ method: "GET", url: "/checkout.js" })).body).not.toContain(LEAKED);
  });

  it("no_request_id_on_retry: a retried checkout creates a second PayPal order (S7)", async () => {
    for (const [app, expectedDistinct] of [
      [ALL.app, 2],
      [GOOD.app, 1],
    ] as const) {
      expect((await app.inject({ method: "POST", url: TEST_HOOK_PATH, headers: auth, payload: { simulate: "create_retry" } })).statusCode).toBe(204);
      const id = await newOrder(app);
      const attempts: string[] = (await status(app, id)).createAttempts;
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts).size).toBe(expectedDistinct);
    }
  });

  it("no_security_headers: no CSP or HSTS on the buggy store (S8)", async () => {
    const bad = await ALL.app.inject({ method: "GET", url: "/" });
    expect(bad.headers["content-security-policy"]).toBeUndefined();
    expect(bad.headers["strict-transport-security"]).toBeUndefined();
    expect((await GOOD.app.inject({ method: "GET", url: "/" })).headers["content-security-policy"]).toBeDefined();
  });

  it("no_pay_later: no messages component and no placement on the buggy page (C2)", async () => {
    const bad = (await ALL.app.inject({ method: "GET", url: "/" })).body;
    expect(bad).not.toContain("data-pp-message");
    expect(bad).toContain("components=buttons&amp;");
    const good = (await GOOD.app.inject({ method: "GET", url: "/" })).body;
    expect(good).toContain("data-pp-message");
    expect(good).toContain("enable-funding=paylater,venmo");
  });

  it("agent_price_mismatch: the buggy page publishes a stale structured price; the good page publishes the real one (A4)", async () => {
    const offers = (body: string) => {
      const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(body)?.[1];
      const graph = (JSON.parse(json!) as { "@graph": { sku: string; offers: { price: string; priceCurrency: string } }[] })["@graph"];
      return Object.fromEntries(graph.map((p) => [p.sku, `${p.offers.price} ${p.offers.priceCurrency}`]));
    };
    const good = offers((await GOOD.app.inject({ method: "GET", url: "/" })).body);
    const bad = offers((await ALL.app.inject({ method: "GET", url: "/" })).body);
    expect(good["LAMP-01"]).toBe("50.00 USD");
    expect(bad["LAMP-01"]).toBe("45.00 USD");
    // ...while checkout still charges the server price.
    const id = await newOrder(ALL.app, { sku: "LAMP-01", quantity: 1 });
    expect(ALL.amounts.get(id)).toBe("50.00");
  });

  it("unlabeled_controls: the buggy page drops the <label>s of the product picker and quantity box (A5)", async () => {
    const good = (await GOOD.app.inject({ method: "GET", url: "/" })).body;
    const bad = (await ALL.app.inject({ method: "GET", url: "/" })).body;
    expect(good).toContain('<label for="sku">Product</label>');
    expect(good).toContain('<label for="qty">Quantity</label>');
    expect(bad).not.toContain("<label for=");
    expect(bad).toContain('<div class="label">Product</div>');
  });

  it("lists exactly the ten seeded bugs (docs/seeded-bugs.md)", () => {
    expect([...SEEDED_BUGS].sort()).toEqual(
      [
        "accept_unsigned_webhooks",
        "agent_price_mismatch",
        "expose_client_secret",
        "no_pay_later",
        "no_request_id_on_retry",
        "no_security_headers",
        "no_webhook_dedup",
        "refund_webhook_broken",
        "trust_client_price",
        "unlabeled_controls",
      ].sort(),
    );
  });
});
