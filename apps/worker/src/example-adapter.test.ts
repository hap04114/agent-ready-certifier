/**
 * The thin store-contract adapter in front of PayPal's example (thirdparty/paypal-standard-integration).
 * A fake "example server" answers like the real one; the adapter must pass everything through
 * unchanged and report only what the example's own responses said.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../../thirdparty/paypal-standard-integration/", import.meta.url));
type AdapterModule = {
  startAdapter: (o: Record<string, unknown>) => { server: Server };
};

const CAPTURED = {
  id: "ORDER12345",
  status: "COMPLETED",
  purchase_units: [{ payments: { captures: [{ id: "CAP1234567", status: "COMPLETED", amount: { currency_code: "USD", value: "100.00" } }] } }],
};

let upstream: Server;
let adapter: Server;
let base = "";
const captures = new Map<string, number>();

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/orders") {
        res.writeHead(201, { "content-type": "application/json", "x-echo-length": String(body.length) }).end('{"id":"ORDER12345","status":"CREATED"}');
        return;
      }
      const m = /^\/api\/orders\/([^/]+)\/capture$/.exec(req.url ?? "");
      if (req.method === "POST" && m) {
        const n = (captures.get(m[1]!) ?? 0) + 1;
        captures.set(m[1]!, n);
        // Like the example: the first capture succeeds, any later one fails with its generic 500.
        if (m[1] === "ORDER12345" && n === 1) res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(CAPTURED));
        else res.writeHead(500, { "content-type": "application/json" }).end('{"error":"Failed to capture order."}');
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const mod = (await import(pathToFileURL(join(DIR, "adapter.mjs")).href)) as AdapterModule;
  adapter = mod.startAdapter({
    port: 0,
    host: "127.0.0.1",
    upstreamPort: (upstream.address() as AddressInfo).port,
    clientDir: join(DIR, "example", "client"),
    clientId: "SANDBOX-CLIENT-ID",
    ownershipToken: "arc-test-token",
    statusKey: "test-status-key",
  }).server;
  await new Promise<void>((r) => (adapter.listening ? r() : adapter.once("listening", () => r())));
  base = `http://127.0.0.1:${(adapter.address() as AddressInfo).port}`;
});

afterAll(() => {
  adapter?.close();
  upstream?.close();
});

const status = (id: string, key = "test-status-key") => fetch(`${base}/.well-known/certifier/orders/${id}`, { headers: { authorization: `Bearer ${key}` } });

describe("example store adapter", () => {
  it("serves the example's page with only Vite's client-ID substitution and the ownership tag", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("client-id=SANDBOX-CLIENT-ID&");
    expect(html).not.toContain("%PAYPAL_CLIENT_ID%");
    expect(html).toContain('<meta name="agent-ready-certifier" content="arc-test-token" />');
    expect(html).toContain('<script src="app.js"></script>');
    expect(await (await fetch(`${base}/.well-known/certifier/ownership.txt`)).text()).toBe("arc-test-token");
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
  });

  it("adds no security headers, webhook handler or test hook of its own", async () => {
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-security-policy")).toBeNull();
    expect(page.headers.get("strict-transport-security")).toBeNull();
    expect((await fetch(`${base}/webhooks/paypal`, { method: "POST", body: "{}" })).status).toBe(404);
    const hook = await fetch(`${base}/.well-known/certifier/test-hook`, { method: "POST", headers: { authorization: "Bearer test-status-key" }, body: "{}" });
    expect(hook.status).toBe(404);
  });

  it("forwards create and capture unchanged and reports what the example's responses said", async () => {
    const sent = '{"cart":[{"id":"YOUR_PRODUCT_ID","quantity":"1","price":"1.00"}]}';
    const created = await fetch(`${base}/api/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: sent });
    expect(created.status).toBe(201);
    expect(created.headers.get("x-echo-length")).toBe(String(sent.length));
    expect(await created.json()).toEqual({ id: "ORDER12345", status: "CREATED" });
    expect(await (await status("ORDER12345")).json()).toMatchObject({ status: "created", captureIds: [], fulfilmentCount: 0 });

    const cap = await fetch(`${base}/api/orders/ORDER12345/capture`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(cap.status).toBe(201);
    expect(await cap.json()).toEqual(CAPTURED);
    expect(await (await status("ORDER12345")).json()).toMatchObject({
      status: "paid",
      captureIds: ["CAP1234567"],
      amount: { currencyCode: "USD", value: "100.00" },
      fulfilmentCount: 1,
    });
  });

  it("a refused second capture leaves the order paid and fulfilled once", async () => {
    const again = await fetch(`${base}/api/orders/ORDER12345/capture`, { method: "POST" });
    expect(again.status).toBe(500);
    expect(await (await status("ORDER12345")).json()).toMatchObject({ status: "paid", fulfilmentCount: 1 });
  });

  it("a failed first capture is reported as failed, never paid", async () => {
    expect((await fetch(`${base}/api/orders/FAILED1234/capture`, { method: "POST" })).status).toBe(500);
    expect(await (await status("FAILED1234")).json()).toMatchObject({ status: "failed", captureIds: [], fulfilmentCount: 0 });
  });

  it("the status endpoint needs the private status key", async () => {
    expect((await fetch(`${base}/.well-known/certifier/orders/ORDER12345`)).status).toBe(401);
    expect((await status("ORDER12345", "wrong-key")).status).toBe(401);
    expect((await status("UNKNOWN999")).status).toBe(404);
  });
});
