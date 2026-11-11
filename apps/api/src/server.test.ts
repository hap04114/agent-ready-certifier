import { SANDBOX_API_BASE, parseConfig } from "@certifier/config";
import { type Db, certifierRepo, migrateCertifier } from "@certifier/db";
import { createTestDb } from "@certifier/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi } from "./server.js";

const base = { PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: SANDBOX_API_BASE };
let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await migrateCertifier(db);
});
afterAll(() => db.close());

const event = JSON.stringify({ id: "WH-9", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP9", supplementary_data: { related_ids: { order_id: "O9" } } } });
const headers = { "content-type": "application/json", "paypal-transmission-id": "TX-9" };

describe("pages", () => {
  const app = () => buildApi(parseConfig(base), { logger: false });
  it("serves the landing page at /, the console at /console and the simulator at /simulator", async () => {
    const home = await app().inject({ method: "GET", url: "/" });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain("<title>Agent-Ready Certifier</title>");
    expect(home.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await app().inject({ method: "GET", url: "/console" })).body).toContain("Model safety scorecard");
    expect((await app().inject({ method: "GET", url: "/simulator" })).body).toContain("Planted-bug simulator");
  });

  it("keeps old console links working: /?demo=1 redirects to /console?demo=1", async () => {
    const res = await app().inject({ method: "GET", url: "/?demo=1" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/console?demo=1");
  });

  it("serves the simulator's script and its recorded data", async () => {
    expect((await app().inject({ method: "GET", url: "/assets/simulator.js" })).statusCode).toBe(200);
    const data = await app().inject({ method: "GET", url: "/assets/simulator-data.json" });
    expect(data.statusCode).toBe(200);
    const d = data.json() as { runs: { good: { checks: Record<string, unknown> }; buggy: { checks: Record<string, unknown> } }; bugs: unknown[] };
    expect(Object.keys(d.runs.good.checks)).toHaveLength(21);
    expect(Object.keys(d.runs.buggy.checks)).toHaveLength(21);
    expect(d.bugs).toHaveLength(10);
  });
});

describe("api", () => {
  it("reports sandbox on /health", async () => {
    const app = buildApi(parseConfig(base), { logger: false });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ ok: true, paypalEnv: "sandbox", paypalApiBase: SANDBOX_API_BASE, webhookListener: "not configured" });
  });

  it("answers 503 when the listener is not configured", async () => {
    const app = buildApi(parseConfig(base), { logger: false });
    expect((await app.inject({ method: "POST", url: "/webhooks/paypal", headers, payload: event })).statusCode).toBe(503);
  });

  it("stores verified events and rejects (but records) forged ones", async () => {
    const repo = certifierRepo(db);
    const config = parseConfig({ ...base, PAYPAL_WEBHOOK_ID: "WH-ID" });
    const good = buildApi(config, { repo, logger: false, verifyWebhook: async () => ({ valid: true, chainVerified: true }) });
    expect((await good.inject({ method: "POST", url: "/webhooks/paypal", headers, payload: event })).statusCode).toBe(200);

    const bad = buildApi(config, { repo, logger: false, verifyWebhook: async () => ({ valid: false, reason: "bad_signature" }) });
    const forged = JSON.stringify({ id: "WH-F", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPF" } });
    expect((await bad.inject({ method: "POST", url: "/webhooks/paypal", headers: { ...headers, "paypal-transmission-id": "TX-F" }, payload: forged })).statusCode).toBe(400);

    expect((await repo.findSignedEvent("PAYMENT.CAPTURE.COMPLETED", "CAP9"))).toMatchObject({ event_id: "WH-9", related_order_id: "O9" });
    expect(await repo.findSignedEvent("PAYMENT.CAPTURE.COMPLETED", "CAPF")).toBeUndefined();
    const rows = (await db.query("SELECT event_id, signature_valid, verify_reason FROM certifier.webhook_events ORDER BY event_id")).rows;
    expect(rows).toEqual([
      { event_id: "WH-9", signature_valid: true, verify_reason: null },
      { event_id: "WH-F", signature_valid: false, verify_reason: "bad_signature" },
    ]);
  });
});
