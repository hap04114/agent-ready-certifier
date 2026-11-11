/**
 * Trust layer: signed certificates and a tamper-evident hash log. Node's built-in crypto only.
 *
 * - A certificate is a compact JWS (EdDSA / Ed25519) over a small payload that names the store,
 *   the run, the result counts, the failed checks and the SHA-256 of the run's canonical summary.
 *   Anyone can verify it with the public key at /.well-known/certifier/jwks.json, and recompute
 *   the summary hash from the published summary.
 * - The hash log chains every certificate: entry_hash = SHA-256(preimage), where the preimage
 *   names the previous entry's hash. Editing any past entry breaks every later link.
 * - Optionally, each entry hash is timestamped publicly with OpenTimestamps (only the hash leaves).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export interface SummaryCheck {
  code: string;
  pillar: string;
  status: "pass" | "fail" | "inconclusive";
  evidence: { kind: string; id: string; strength: string }[];
}

export interface RunSummary {
  certifier: "agent-ready-certifier";
  sandbox: true;
  runId: string;
  store: string;
  judgedAt: string;
  totals: { pass: number; fail: number; inconclusive: number };
  checks: SummaryCheck[];
}

/** JSON with sorted keys at every level, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export const sha256Hex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Build the canonical summary of a judged run. Evidence notes (which can quote page text) are left out. */
export function summarizeRun(run: {
  id: string;
  store_url: string;
  finished_at: Date | string | null;
  checks: { code: string; pillar: string; status: string; evidence: { kind: string; id: string; strength: string }[] }[];
}): RunSummary {
  const checks = [...run.checks]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((c) => ({
      code: c.code,
      pillar: c.pillar,
      status: c.status as SummaryCheck["status"],
      evidence: c.evidence.map((e) => ({ kind: e.kind, id: e.id, strength: e.strength })),
    }));
  const count = (s: string) => checks.filter((c) => c.status === s).length;
  return {
    certifier: "agent-ready-certifier",
    sandbox: true,
    runId: run.id,
    store: new URL(run.store_url).origin,
    judgedAt: run.finished_at ? new Date(run.finished_at).toISOString() : "",
    totals: { pass: count("pass"), fail: count("fail"), inconclusive: count("inconclusive") },
    checks,
  };
}

// ------------------------------------------------------------------ keys

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

/** A new Ed25519 key. The private key is base64 PKCS#8 DER, for one env var (CERT_SIGNING_KEY). */
export function generateSigningKey(): { privateKey: string; publicJwk: PublicJwk } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const b64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  return { privateKey: b64, publicJwk: publicJwkOf(b64) };
}

export function publicJwkOf(privateKeyB64: string): PublicJwk {
  const priv = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string };
  return { kty: "OKP", crv: "Ed25519", x: jwk.x, kid: sha256Hex(jwk.x).slice(0, 16), alg: "EdDSA", use: "sig" };
}

// ------------------------------------------------------------------ certificates

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export interface CertificatePayload {
  iss: string;
  sub: string;
  jti: string;
  iat: number;
  sandbox: true;
  summary_sha256: string;
  totals: RunSummary["totals"];
  failed: string[];
  inconclusive: string[];
  statement: string;
}

export function issueCertificate(summary: RunSummary, privateKeyB64: string, issuer: string, now = Date.now()): { jws: string; payload: CertificatePayload } {
  const jwk = publicJwkOf(privateKeyB64);
  const failed = summary.checks.filter((c) => c.status === "fail").map((c) => c.code);
  const inconclusive = summary.checks.filter((c) => c.status === "inconclusive").map((c) => c.code);
  const payload: CertificatePayload = {
    iss: issuer,
    sub: summary.store,
    jti: summary.runId,
    iat: Math.floor(now / 1000),
    sandbox: true,
    summary_sha256: sha256Hex(canonicalJson(summary)),
    totals: summary.totals,
    failed,
    inconclusive,
    statement: `${summary.totals.pass} of ${summary.checks.length} checks passed in the PayPal sandbox${failed.length ? `; failed: ${failed.join(", ")}` : "; none failed"}. Verdicts were decided by plain code from PayPal's records.`,
  };
  const header = { alg: "EdDSA", typ: "JWT", kid: jwk.kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(signingInput), key);
  return { jws: `${signingInput}.${b64url(signature)}`, payload };
}

export function verifyCertificate(jws: string, jwk: Pick<PublicJwk, "x" | "kid">): { valid: boolean; payload?: CertificatePayload; reason?: string } {
  const parts = jws.split(".");
  if (parts.length !== 3) return { valid: false, reason: "not a compact JWS" };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let payload: CertificatePayload;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "unreadable header or payload" };
  }
  if (header.alg !== "EdDSA") return { valid: false, reason: "unexpected algorithm" };
  if (header.kid !== jwk.kid) return { valid: false, reason: "signed with a different key" };
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  const ok = verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  return ok ? { valid: true, payload } : { valid: false, reason: "bad signature" };
}

// ------------------------------------------------------------------ hash log

export const GENESIS_HASH = "0".repeat(64);

/** The exact text whose SHA-256 is the log entry hash (and the "file" OpenTimestamps timestamps). */
export function logPreimage(e: { seq: number; prevHash: string; runId: string; summarySha256: string; certificateSha256: string; createdAt: string }): string {
  return `agent-ready-certifier hash log v1\nseq: ${e.seq}\nprev: ${e.prevHash}\nrun: ${e.runId}\nsummary_sha256: ${e.summarySha256}\ncertificate_sha256: ${e.certificateSha256}\ncreated_at: ${e.createdAt}\n`;
}

/** Re-check a whole chain: every entry's hash matches its preimage and links to the one before. */
export function verifyChain(entries: { seq: number; prevHash: string; entryHash: string; preimage: string }[]): { valid: boolean; brokenAt?: number } {
  let prev = GENESIS_HASH;
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (e.prevHash !== prev || sha256Hex(e.preimage) !== e.entryHash || !e.preimage.includes(`prev: ${e.prevHash}\n`)) return { valid: false, brokenAt: e.seq };
    prev = e.entryHash;
  }
  return { valid: true };
}

// ------------------------------------------------------------------ OpenTimestamps

export const OTS_CALENDAR = "https://a.pool.opentimestamps.org";
const OTS_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");

/**
 * Submit a SHA-256 digest (hex) to a public OpenTimestamps calendar. Only the 32-byte hash is
 * sent. Returns a detached .ots proof (pending until the calendar anchors it in Bitcoin, usually
 * within hours; then `ots upgrade` / `ots verify` complete it).
 */
export async function submitToOpenTimestamps(digestHex: string, fetcher: typeof fetch = fetch, calendar = OTS_CALENDAR): Promise<Buffer> {
  const digest = Buffer.from(digestHex, "hex");
  if (digest.length !== 32) throw new Error("OpenTimestamps needs a 32-byte SHA-256 digest");
  const res = await fetcher(`${calendar}/digest`, {
    method: "POST",
    headers: { accept: "application/vnd.opentimestamps.v1", "content-type": "application/x-www-form-urlencoded" },
    body: digest,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenTimestamps calendar answered HTTP ${res.status}`);
  const timestamp = Buffer.from(await res.arrayBuffer());
  // Detached timestamp file: magic, version 1, SHA-256 file-hash op (0x08), the digest, the timestamp.
  return Buffer.concat([OTS_MAGIC, Buffer.from([0x01, 0x08]), digest, timestamp]);
}
