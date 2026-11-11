/**
 * Trust endpoints: signed run certificates, the public key to verify them, and the hash log.
 * A certificate is issued once per judged run (on first request) and never changes. Each one is
 * appended to the hash chain and, unless FEATURE_OPENTIMESTAMPS=off, its entry hash (only the
 * hash) is timestamped publicly with OpenTimestamps.
 */
import type { Config } from "@certifier/config";
import type { CertifierRepo } from "@certifier/db";
import {
  OTS_CALENDAR,
  canonicalJson,
  issueCertificate,
  logPreimage,
  publicJwkOf,
  sha256Hex,
  submitToOpenTimestamps,
  summarizeRun,
  verifyCertificate,
  verifyChain,
} from "@certifier/trust";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export interface TrustDeps {
  config: Config;
  repo: CertifierRepo;
  /** Override the public timestamping (tests). Return undefined to skip. */
  timestamp?: (digestHex: string) => Promise<Buffer | undefined>;
}

const uuid = z.object({ id: z.uuid() });
const seqParam = z.object({ seq: z.coerce.number().int().positive() });

/**
 * Issue (once) the certificate for a judged run and append it to the hash log. Shared by the API
 * and the `cert:issue` command. Returns an error code instead of throwing for expected cases.
 */
export async function ensureCertificate(deps: TrustDeps, runId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { config, repo } = deps;
  if (await repo.getCertificate(runId)) return { ok: true };
  const key = config.CERT_SIGNING_KEY;
  if (!key) return { ok: false, status: 503, error: "signing_not_configured" };
  const jwk = publicJwkOf(key);
  const issuer = (config.API_BASE_URL ?? "https://certifier-api.onrender.com").replace(/\/+$/, "");
  const run = await repo.getRun(runId);
  if (!run) return { ok: false, status: 404, error: "unknown_run" };
  if (run.status !== "judged") return { ok: false, status: 409, error: "run_not_judged" };
  const summary = summarizeRun(run);
  const { jws } = issueCertificate(summary, key, issuer);
  const summarySha256 = sha256Hex(canonicalJson(summary));
  const created = await repo.saveCertificate({ runId: run.id, jws, summary, summarySha256, kid: jwk.kid }, (prev) => {
    const createdAt = new Date().toISOString();
    const preimage = logPreimage({ seq: prev.seq + 1, prevHash: prev.hash, runId: run.id, summarySha256, certificateSha256: sha256Hex(jws), createdAt });
    return { preimage, entryHash: sha256Hex(preimage), createdAt };
  });
  if (created) {
    const timestamp = deps.timestamp ?? ((hex: string) => (config.FEATURE_OPENTIMESTAMPS === "off" ? Promise.resolve(undefined) : submitToOpenTimestamps(hex)));
    const proof = await timestamp(created.entryHash).catch(() => undefined);
    if (proof) await repo.setOtsProof(created.seq, OTS_CALENDAR, proof);
  }
  return { ok: true };
}

export function registerTrustRoutes(app: FastifyInstance, deps: TrustDeps) {
  const { config, repo } = deps;
  const key = config.CERT_SIGNING_KEY;
  const jwk = key ? publicJwkOf(key) : undefined;
  const issuer = (config.API_BASE_URL ?? "https://certifier-api.onrender.com").replace(/\/+$/, "");

  app.get("/.well-known/certifier/jwks.json", async (_req, reply) =>
    jwk ? { keys: [jwk] } : reply.code(503).send({ error: "signing_not_configured" }),
  );

  app.get("/api/runs/:id/certificate", async (req, reply) => {
    const p = uuid.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_id" });
    const issued = await ensureCertificate(deps, p.data.id);
    if (!issued.ok) return reply.code(issued.status).send({ error: issued.error });
    const cert = await repo.getCertificate(p.data.id);
    if (!cert) return reply.code(500).send({ error: "certificate_unavailable" });
    const entry = await repo.getLogEntryForRun(p.data.id);
    const check = jwk ? verifyCertificate(cert.jws, jwk) : { valid: false };
    return {
      certificate: cert.jws,
      payload: check.valid ? check.payload : JSON.parse(Buffer.from(cert.jws.split(".")[1] ?? "", "base64url").toString("utf8") || "{}"),
      verified: check.valid,
      summary: cert.summary,
      summarySha256: cert.summary_sha256,
      issuedAt: cert.issued_at,
      publicKey: `${issuer}/.well-known/certifier/jwks.json`,
      hashLog: entry
        ? {
            seq: entry.seq,
            prevHash: entry.prev_hash,
            entryHash: entry.entry_hash,
            entryText: `${issuer}/api/hashlog/${entry.seq}/entry.txt`,
            openTimestamps: entry.has_ots ? { calendar: entry.ots_calendar, proof: `${issuer}/api/hashlog/${entry.seq}/proof.ots` } : null,
          }
        : null,
      howToVerify:
        "Check the JWS (EdDSA) with the public key at publicKey; recompute SHA-256 of the canonical JSON of summary and compare with summary_sha256 in the payload; the hash-log entry text hashes to entryHash and names the previous entry; the .ots proof can be checked with the OpenTimestamps client (ots verify).",
    };
  });

  app.post("/api/certificates/verify", async (req, reply) => {
    const body = z.object({ certificate: z.string().max(20_000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    if (!jwk) return reply.code(503).send({ error: "signing_not_configured" });
    return verifyCertificate(body.data.certificate, jwk);
  });

  app.get("/api/hashlog", async () => {
    const entries = await repo.listHashLog();
    const chain = verifyChain(entries.map((e) => ({ seq: e.seq, prevHash: e.prev_hash, entryHash: e.entry_hash, preimage: e.preimage })));
    return {
      chainValid: chain.valid,
      ...(chain.brokenAt ? { brokenAt: chain.brokenAt } : {}),
      entries: entries.map((e) => ({ seq: e.seq, runId: e.run_id, prevHash: e.prev_hash, entryHash: e.entry_hash, createdAt: e.created_at, openTimestamps: e.has_ots })),
    };
  });

  app.get("/api/hashlog/:seq/entry.txt", async (req, reply) => {
    const p = seqParam.safeParse(req.params);
    const e = p.success ? await repo.getLogEntry(p.data.seq) : undefined;
    if (!e) return reply.code(404).send({ error: "not_found" });
    return reply.type("text/plain; charset=utf-8").header("content-disposition", `attachment; filename="hashlog-${e.seq}.txt"`).send(e.preimage);
  });

  app.get("/api/hashlog/:seq/proof.ots", async (req, reply) => {
    const p = seqParam.safeParse(req.params);
    const e = p.success ? await repo.getLogEntry(p.data.seq) : undefined;
    if (!e?.ots_proof) return reply.code(404).send({ error: "not_found" });
    return reply.type("application/octet-stream").header("content-disposition", `attachment; filename="hashlog-${e.seq}.txt.ots"`).send(e.ots_proof);
  });
}
