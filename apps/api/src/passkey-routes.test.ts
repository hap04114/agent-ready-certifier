import { createHash } from "node:crypto";
import { SANDBOX_API_BASE, parseConfig } from "@certifier/config";
import { type CertifierRepo, type Db, certifierRepo, migrateCertifier } from "@certifier/db";
import { createTestDb } from "@certifier/db/testing";
import { relyingPartyOf } from "@certifier/trust";
import { softAuthenticator } from "@certifier/trust/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi } from "./server.js";

const config = parseConfig({ PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: SANDBOX_API_BASE, API_BASE_URL: "https://certifier.example" });
const rp = relyingPartyOf(config.API_BASE_URL);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let db: Db;
let repo: CertifierRepo;
beforeAll(async () => {
  db = await createTestDb();
  await migrateCertifier(db);
  repo = certifierRepo(db);
});
afterAll(() => db.close());

const newRequest = () =>
  repo.createApproval({ batchId: "b1", scenario: "A2-passkey", trialNo: 1, model: "groq:test", currency: "USD", currentLimit: "20.00", requestedLimit: "200.00", agentReason: "<img src=x> need the lamp", ttlMinutes: 5 });

describe("owner approvals with passkeys", () => {
  // Built after the test database exists (the top-level beforeAll runs first).
  let app: ReturnType<typeof buildApi>;
  beforeAll(() => {
    app = buildApi(config, { repo, logger: false });
  });
  const owner = softAuthenticator(rp);
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });

  it("cannot approve before any passkey is registered", async () => {
    const id = await newRequest();
    expect((await post(`/api/approvals/${id}/options`, {})).json()).toEqual({ error: "no_passkey_registered" });
  });

  it("registers a passkey only through a valid one-time invite", async () => {
    expect((await post("/api/passkeys/register/options", { invite: "x".repeat(32) })).statusCode).toBe(403);
    const invite = "invite-token-for-the-test-0001";
    await repo.createPasskeyInvite(sha(invite), 15);
    const options = (await post("/api/passkeys/register/options", { invite })).json();
    expect(options.rp.id).toBe("certifier.example");
    const res = await post("/api/passkeys/register/verify", { invite, response: owner.register(options.challenge) });
    expect(res.json()).toEqual({ registered: true });
    // Single use.
    expect((await post("/api/passkeys/register/options", { invite })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/passkeys" })).json().passkeys).toHaveLength(1);
  });

  it("approves only with the owner's signature over this exact request, and anyone can re-check it", async () => {
    const id = await newRequest();
    const { options, request } = (await post(`/api/approvals/${id}/options`, {})).json();
    expect(request.agentReason).toBe("<img src=x> need the lamp");
    // A device that was never registered is refused.
    const stranger = softAuthenticator(rp);
    expect((await post(`/api/approvals/${id}/approve`, { response: stranger.assert(options.challenge) })).statusCode).toBe(403);
    // A signature made on a lookalike origin is refused.
    expect((await post(`/api/approvals/${id}/approve`, { response: owner.assert(options.challenge, "https://certifier-example.evil") })).statusCode).toBe(403);
    expect((await repo.getApproval(id))?.status).toBe("pending");

    expect((await post(`/api/approvals/${id}/approve`, { response: owner.assert(options.challenge) })).json()).toEqual({ approved: true });
    const detail = (await app.inject({ method: "GET", url: `/api/approvals/${id}` })).json();
    expect(detail.status).toBe("approved");
    expect(detail.proof.signatureValid).toBe(true);
    expect(detail.proof.signedContent).toMatchObject({ id, requestedLimit: "200.00", currency: "USD" });
    // Already decided: a second approval (or a replay) changes nothing.
    expect((await post(`/api/approvals/${id}/approve`, { response: owner.assert(options.challenge) })).statusCode).toBe(409);
  });

  it("a signature for one request cannot approve another", async () => {
    const first = await newRequest();
    const second = await newRequest();
    const a = (await post(`/api/approvals/${first}/options`, {})).json();
    await post(`/api/approvals/${second}/options`, {});
    expect((await post(`/api/approvals/${second}/approve`, { response: owner.assert(a.options.challenge) })).statusCode).toBe(403);
  });

  it("deny and expiry never approve", async () => {
    const id = await newRequest();
    expect((await post(`/api/approvals/${id}/deny`, {})).json()).toEqual({ denied: true });
    expect((await post(`/api/approvals/${id}/options`, {})).json()).toMatchObject({ error: "not_pending", status: "denied" });
    const old = await repo.createApproval({ batchId: "b1", scenario: "A2-passkey", trialNo: 2, model: "m", currency: "USD", currentLimit: "20.00", requestedLimit: "200.00", ttlMinutes: 0 });
    expect((await repo.getApproval(old))?.status).toBe("expired");
    expect((await post(`/api/approvals/${old}/options`, {})).statusCode).toBe(409);
  });

  it("serves the owner page with the passkey helper", async () => {
    const page = await app.inject({ method: "GET", url: "/owner" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await app.inject({ method: "GET", url: "/assets/simplewebauthn-browser.js" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/assets/owner.js" })).statusCode).toBe(200);
  });
});
