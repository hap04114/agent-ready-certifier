import { SANDBOX_API_BASE, parseConfig } from "@certifier/config";
import { type CertifierRepo, type Db, certifierRepo, migrateCertifier } from "@certifier/db";
import { createTestDb } from "@certifier/db/testing";
import { canonicalJson, generateSigningKey, sha256Hex, verifyCertificate } from "@certifier/trust";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi } from "./server.js";

const key = generateSigningKey();
const config = parseConfig({ PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: SANDBOX_API_BASE, CERT_SIGNING_KEY: key.privateKey, API_BASE_URL: "https://certifier.example" });

let db: Db;
let repo: CertifierRepo;
beforeAll(async () => {
  db = await createTestDb();
  await migrateCertifier(db);
  repo = certifierRepo(db);
});
afterAll(() => db.close());

async function judgedRun(status: "pass" | "fail") {
  const runId = await repo.createRun({ storeUrl: "https://shop.example", budgetRequests: 300, timeLimitMin: 20 });
  await repo.saveVerdict(runId, "secure", { check: "S1", status, summary: "s", reasons: [], evidence: [{ kind: "order", id: "5T6", strength: "paypal-api" }] });
  await repo.finishRun(runId, "judged", 10, {});
  return runId;
}

describe("trust endpoints", () => {
  const stamped: string[] = [];
  const app = () => buildApi(config, { repo, logger: false, timestamp: async (hex) => {
      stamped.push(hex);
      return Buffer.from("ots-proof");
    },
  });

  it("publishes the public key", async () => {
    const res = await app().inject({ method: "GET", url: "/.well-known/certifier/jwks.json" });
    expect(res.json()).toEqual({ keys: [key.publicJwk] });
  });

  it("issues one certificate per judged run, verifiable with the public key, chained in the hash log", async () => {
    const a = await judgedRun("fail");
    const b = await judgedRun("pass");
    const ca = (await app().inject({ method: "GET", url: `/api/runs/${a}/certificate` })).json();
    const cb = (await app().inject({ method: "GET", url: `/api/runs/${b}/certificate` })).json();
    expect(ca.verified).toBe(true);
    expect(verifyCertificate(ca.certificate, key.publicJwk).valid).toBe(true);
    expect(ca.payload).toMatchObject({ sub: "https://shop.example", jti: a, failed: ["S1"] });
    // The summary hashes to what the signed payload says.
    expect(sha256Hex(canonicalJson(ca.summary))).toBe(ca.payload.summary_sha256);
    // Asking again returns the same certificate, not a new one.
    const again = (await app().inject({ method: "GET", url: `/api/runs/${a}/certificate` })).json();
    expect(again.certificate).toBe(ca.certificate);
    // Chained: b's entry points at a's.
    expect(cb.hashLog.prevHash).toBe(ca.hashLog.entryHash);
    expect(stamped).toEqual([ca.hashLog.entryHash, cb.hashLog.entryHash]);
    const log = (await app().inject({ method: "GET", url: "/api/hashlog" })).json();
    expect(log.chainValid).toBe(true);
    expect((await app().inject({ method: "GET", url: `/api/hashlog/${ca.hashLog.seq}/proof.ots` })).body).toBe("ots-proof");
    const entryText = (await app().inject({ method: "GET", url: `/api/hashlog/${ca.hashLog.seq}/entry.txt` })).body;
    expect(sha256Hex(entryText)).toBe(ca.hashLog.entryHash);
  });

  it("refuses runs that were not judged, and rejects a tampered certificate", async () => {
    const runId = await repo.createRun({ storeUrl: "https://shop.example", budgetRequests: 300, timeLimitMin: 20 });
    expect((await app().inject({ method: "GET", url: `/api/runs/${runId}/certificate` })).statusCode).toBe(409);
    const good = (await app().inject({ method: "GET", url: `/api/runs/${await judgedRun("pass")}/certificate` })).json();
    const tampered = `${good.certificate.slice(0, -4)}AAAA`;
    expect((await app().inject({ method: "POST", url: "/api/certificates/verify", payload: { certificate: tampered } })).json()).toMatchObject({ valid: false });
  });
});
