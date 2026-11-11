import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  canonicalJson,
  generateSigningKey,
  issueCertificate,
  logPreimage,
  sha256Hex,
  submitToOpenTimestamps,
  summarizeRun,
  verifyCertificate,
  verifyChain,
} from "./index.js";

const run = {
  id: "11111111-2222-3333-4444-555555555555",
  store_url: "https://demo-store-good.onrender.com/",
  finished_at: "2026-11-11T07:00:00.000Z",
  checks: [
    { code: "W1", pillar: "works", status: "pass", evidence: [{ kind: "order", id: "1AB", strength: "paypal-api" }] },
    { code: "S1", pillar: "secure", status: "fail", evidence: [{ kind: "order", id: "5T6", strength: "paypal-api" }] },
    { code: "C4", pillar: "current", status: "inconclusive", evidence: [] },
  ],
};

describe("trust layer", () => {
  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  });

  it("issues a certificate that verifies, and fails on any tampering or another key", () => {
    const key = generateSigningKey();
    const summary = summarizeRun(run);
    const { jws, payload } = issueCertificate(summary, key.privateKey, "https://certifier.example");
    expect(payload).toMatchObject({ sub: "https://demo-store-good.onrender.com", jti: run.id, failed: ["S1"], inconclusive: ["C4"], totals: { pass: 1, fail: 1, inconclusive: 1 } });
    expect(payload.summary_sha256).toBe(sha256Hex(canonicalJson(summary)));
    expect(verifyCertificate(jws, key.publicJwk).valid).toBe(true);

    const [h, , s] = jws.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...payload, failed: [] })).toString("base64url");
    expect(verifyCertificate(`${h}.${forged}.${s}`, key.publicJwk)).toMatchObject({ valid: false, reason: "bad signature" });
    expect(verifyCertificate(jws, generateSigningKey().publicJwk)).toMatchObject({ valid: false, reason: "signed with a different key" });
  });

  it("the hash log detects an edited past entry", () => {
    const entries: { seq: number; prevHash: string; entryHash: string; preimage: string }[] = [];
    let prev = GENESIS_HASH;
    for (let seq = 1; seq <= 3; seq++) {
      const preimage = logPreimage({ seq, prevHash: prev, runId: `run-${seq}`, summarySha256: sha256Hex(`s${seq}`), certificateSha256: sha256Hex(`c${seq}`), createdAt: "2026-11-11T07:00:00Z" });
      const entryHash = sha256Hex(preimage);
      entries.push({ seq, prevHash: prev, entryHash, preimage });
      prev = entryHash;
    }
    expect(verifyChain(entries)).toEqual({ valid: true });
    entries[1]!.preimage = entries[1]!.preimage.replace("run-2", "run-X");
    expect(verifyChain(entries)).toEqual({ valid: false, brokenAt: 2 });
  });

  it("sends only the 32-byte hash to OpenTimestamps and builds a detached .ots proof", async () => {
    let sent: Buffer | undefined;
    const f = (async (_url: string, init: RequestInit) => {
      sent = Buffer.from(init.body as Buffer);
      return new Response(new Uint8Array([0xf0, 0x10]), { status: 200 });
    }) as unknown as typeof fetch;
    const digest = sha256Hex("entry");
    const ots = await submitToOpenTimestamps(digest, f);
    expect(sent!.toString("hex")).toBe(digest);
    expect(ots.subarray(1, 15).toString()).toBe("OpenTimestamps");
    expect(ots.subarray(-34, -2).toString("hex")).toBe(digest);
  });
});
