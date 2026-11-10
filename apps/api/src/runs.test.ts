import { SANDBOX_API_BASE, parseConfig } from "@certifier/config";
import { type CertifierRepo, type Db, certifierRepo, migrateCertifier } from "@certifier/db";
import { createTestDb } from "@certifier/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RunStarter } from "./runs.js";
import { buildApi } from "./server.js";

const ADMIN = "admin-token-for-tests";
const auth = { authorization: `Bearer ${ADMIN}` };
const config = parseConfig({
  PAYPAL_ENV: "sandbox",
  PAYPAL_API_BASE: SANDBOX_API_BASE,
  OWNERSHIP_TOKEN_SECRET: "o".repeat(40),
  CERTIFIER_ADMIN_TOKEN: ADMIN,
});

let db: Db;
let repo: CertifierRepo;
beforeAll(async () => {
  db = await createTestDb();
  await migrateCertifier(db);
  repo = certifierRepo(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec("TRUNCATE certifier.runs, certifier.stores CASCADE");
});

function api(opts: { owned?: boolean } = {}) {
  const started: { runId: string; store: { url: string; statusKey: string; webhookId?: string } }[] = [];
  let killed = 0;
  const runner: RunStarter = {
    start(args) {
      started.push(args);
      return { kill: () => void killed++ };
    },
  };
  const app = buildApi(config, {
    repo,
    runner,
    logger: false,
    verifyOwnership: async () => (opts.owned === false ? { verified: false, reason: "no matching meta tag on the home page" } : { verified: true, method: "meta" }),
  });
  return { app, started, killed: () => killed };
}

async function register(app: ReturnType<typeof api>["app"], body: Record<string, unknown> = { url: "https://shop.example/path", storeWebhookId: "WH-STORE-123" }) {
  const res = await app.inject({ method: "POST", url: "/api/stores", headers: auth, payload: body });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; url: string; ownershipToken: string };
}

describe("Run API", () => {
  it("requires the admin token for every write", async () => {
    const { app } = api();
    for (const [method, url] of [["POST", "/api/stores"], ["POST", "/api/runs"], ["POST", "/api/stores/00000000-0000-4000-8000-000000000000/verify"], ["POST", "/api/runs/00000000-0000-4000-8000-000000000000/stop"]] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode).toBe(401);
      expect((await app.inject({ method, url, payload: {}, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    }
  });

  it("registers a store by origin and returns its public ownership token, never the webhook ID", async () => {
    const { app } = api();
    const s = await register(app);
    expect(s.url).toBe("https://shop.example");
    expect(s.ownershipToken).toMatch(/^arc-/);
    expect(JSON.stringify(s)).not.toContain("WH-STORE-123");
  });

  it("verifies ownership and records the result, even with an empty JSON body", async () => {
    const { app } = api();
    const s = await register(app);
    const res = await app.inject({ method: "POST", url: `/api/stores/${s.id}/verify`, headers: { ...auth, "content-type": "application/json" }, payload: "" });
    expect(res.json()).toEqual({ verified: true, method: "meta" });
    expect((await repo.getStore(s.id))?.verified_at).not.toBeNull();
  });

  it("refuses to run against a store that does not serve its token (no probe runs)", async () => {
    const { app, started } = api({ owned: false });
    const s = await register(app);
    const res = await app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { storeId: s.id } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "ownership_not_verified" });
    expect(started).toHaveLength(0);
    expect((await repo.getRun(res.json().runId))?.status).toBe("stopped");
  });

  it("starts a run on a verified store with the derived status key and the stored webhook ID", async () => {
    const { app, started } = api();
    const s = await register(app);
    const res = await app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { storeId: s.id } });
    expect(res.statusCode).toBe(202);
    expect(started).toHaveLength(1);
    expect(started[0]!.store).toMatchObject({ url: "https://shop.example", webhookId: "WH-STORE-123" });
    expect(started[0]!.store.statusKey).toHaveLength(43);
    expect((await repo.getRun(res.json().runId))?.status).toBe("ownership_verified");
  });

  it("allows one run at a time", async () => {
    const { app } = api();
    const s = await register(app);
    expect((await app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { storeId: s.id } })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { storeId: s.id } })).statusCode).toBe(409);
  });

  it("kill switch stops an active run", async () => {
    const { app, killed } = api();
    const s = await register(app);
    const { runId } = (await app.inject({ method: "POST", url: "/api/runs", headers: auth, payload: { storeId: s.id } })).json();
    expect((await app.inject({ method: "POST", url: `/api/runs/${runId}/stop`, headers: auth })).statusCode).toBe(202);
    expect(killed()).toBe(1);
    expect((await app.inject({ method: "POST", url: `/api/runs/${runId}/stop`, headers: auth })).statusCode).toBe(404);
  });

  it("shows a run's verdicts and evidence publicly", async () => {
    const { app } = api();
    const runId = await repo.createRun({ storeUrl: "https://shop.example", budgetRequests: 300, timeLimitMin: 20 });
    await repo.saveVerdict(runId, "works", { check: "W1", status: "pass", summary: "ok", reasons: [], evidence: [{ kind: "order", id: "O1", strength: "paypal-api" }] });
    const res = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toEqual([{ code: "W1", pillar: "works", status: "pass", summary: "ok", reasons: [], evidence: [{ kind: "order", id: "O1", strength: "paypal-api", note: null }] }]);
    expect((await app.inject({ method: "GET", url: "/api/runs/not-a-uuid" })).statusCode).toBe(400);
  });
});
