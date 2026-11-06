import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CertifierRepo, certifierRepo, migrateCertifier } from "./certifier.js";
import type { Db } from "./index.js";
import { createTestDb } from "./testing.js";

let db: Db;
let repo: CertifierRepo;
beforeAll(async () => {
  db = await createTestDb();
  await migrateCertifier(db);
  repo = certifierRepo(db);
});
afterAll(() => db.close());

describe("certifier evidence store", () => {
  it("records webhook deliveries once per transmission and finds verified ones", async () => {
    const base = { eventId: "WH-1", type: "PAYMENT.CAPTURE.COMPLETED", resourceId: "CAP1", rawBody: Buffer.from("{}") };
    await repo.recordWebhook({ ...base, transmissionId: "T1", signatureValid: true });
    await repo.recordWebhook({ ...base, transmissionId: "T1", signatureValid: true });
    await repo.recordWebhook({ ...base, eventId: "WH-FAKE", transmissionId: "T9", signatureValid: false, verifyReason: "bad_signature" });
    expect((await db.query("SELECT count(*)::int AS n FROM certifier.webhook_events")).rows).toEqual([{ n: 2 }]);
    expect((await repo.findSignedEvent("PAYMENT.CAPTURE.COMPLETED", "CAP1"))?.event_id).toBe("WH-1");
    expect(await repo.findSignedEvent("PAYMENT.CAPTURE.REFUNDED", "CAP1")).toBeUndefined();
  });

  it("stores verdicts with their evidence", async () => {
    const runId = await repo.createRun({ storeUrl: "http://localhost:5001", budgetRequests: 300, timeLimitMin: 20 });
    await repo.saveVerdict(runId, "works", {
      check: "W1",
      status: "pass",
      summary: "ok",
      reasons: [],
      evidence: [
        { kind: "order", id: "O1", strength: "paypal-api" },
        { kind: "store_record", id: "O1", strength: "store-reported", note: "status paid" },
      ],
    });
    await repo.finishRun(runId, "judged", 12);
    const rows = (await db.query("SELECT c.code, c.status, e.kind, e.strength FROM certifier.checks c JOIN certifier.evidence e ON e.check_id = c.id ORDER BY e.kind")).rows;
    expect(rows).toEqual([
      { code: "W1", status: "pass", kind: "order", strength: "paypal-api" },
      { code: "W1", status: "pass", kind: "store_record", strength: "store-reported" },
    ]);
    await expect(
      repo.saveVerdict(runId, "works", { check: "W2", status: "maybe", summary: "", reasons: [], evidence: [] }),
    ).rejects.toThrow();
  });
});
