/**
 * Self-verification of PayPal webhook signatures, without anyone's client secret.
 *
 * PayPal signs  `<transmission-id>|<transmission-time>|<webhook-id>|<crc32 of raw body>`
 * with SHA256withRSA. The receiver supplies its own webhook ID, so a signature made for one
 * webhook subscription never verifies against another's. The certificate is fetched from the
 * URL in the `paypal-cert-url` header, which must be a sandbox PayPal host over HTTPS.
 */
import { X509Certificate, verify as cryptoVerify } from "node:crypto";
import { rootCertificates } from "node:tls";
import { crc32 } from "node:zlib";

/** Sandbox-only: certificates are accepted only from these hosts. */
export const SANDBOX_CERT_HOSTS = ["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"] as const;

export interface WebhookHeaders {
  transmissionId?: string;
  transmissionTime?: string;
  transmissionSig?: string;
  certUrl?: string;
  authAlgo?: string;
}

/** Pull the PayPal transmission headers out of a lower- or mixed-case header map. */
export function webhookHeadersFrom(headers: Record<string, string | string[] | undefined>): WebhookHeaders {
  const get = (name: string) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    const v = key ? headers[key] : undefined;
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    transmissionId: get("paypal-transmission-id"),
    transmissionTime: get("paypal-transmission-time"),
    transmissionSig: get("paypal-transmission-sig"),
    certUrl: get("paypal-cert-url"),
    authAlgo: get("paypal-auth-algo"),
  };
}

export type VerifyFailure =
  | "missing_headers"
  | "unsupported_algorithm"
  | "cert_url_not_allowed"
  | "cert_fetch_failed"
  | "cert_invalid"
  | "cert_expired"
  | "cert_not_paypal"
  | "cert_chain_invalid"
  | "bad_signature";

export interface VerifyResult {
  valid: boolean;
  reason?: VerifyFailure;
  /** True when the full chain to a system root CA was checked (not only TLS on fetch). */
  chainVerified?: boolean;
}

/** Only https URLs on the sandbox cert hosts, under the notifications cert path. */
export function isAllowedCertUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    (SANDBOX_CERT_HOSTS as readonly string[]).includes(url.hostname.toLowerCase()) &&
    url.pathname.startsWith("/v1/notifications/certs/")
  );
}

/** The exact string PayPal signs. CRC32 is the unsigned decimal of the raw body bytes. */
export function signedMessage(transmissionId: string, transmissionTime: string, webhookId: string, rawBody: Buffer): string {
  return `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody) >>> 0}`;
}

/** Pure signature check. */
export function verifySignature(message: string, signatureB64: string, publicKey: X509Certificate["publicKey"]): boolean {
  try {
    return cryptoVerify("sha256", Buffer.from(message, "utf8"), publicKey, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Split a PEM bundle into certificates. */
export function parsePemChain(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new X509Certificate(b));
}

/** Does the leaf certificate name a PayPal host? */
export function isPaypalCert(cert: X509Certificate): boolean {
  const names = [
    ...(cert.subjectAltName ?? "").split(",").map((s) => s.trim().replace(/^DNS:/, "")),
    ...(cert.subject.match(/CN=([^\n,]+)/)?.slice(1) ?? []),
  ].map((n) => n.toLowerCase());
  return names.some((n) => n === "paypal.com" || n.endsWith(".paypal.com"));
}

let trustedRoots: X509Certificate[] | undefined;
const roots = () => (trustedRoots ??= rootCertificates.map((pem) => new X509Certificate(pem)));

/**
 * Check the chain. Each cert must be signed by the next; the last must be signed by a system
 * root CA. If PayPal served only the leaf, the chain cannot be checked here and we rely on the
 * HTTPS fetch from an allow-listed PayPal host (reported as chainVerified=false).
 */
export function checkChain(chain: X509Certificate[], now = new Date()): { ok: boolean; reason?: VerifyFailure; chainVerified: boolean } {
  const leaf = chain[0];
  if (!leaf) return { ok: false, reason: "cert_invalid", chainVerified: false };
  for (const cert of chain) {
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) return { ok: false, reason: "cert_expired", chainVerified: false };
  }
  if (!isPaypalCert(leaf)) return { ok: false, reason: "cert_not_paypal", chainVerified: false };
  if (chain.length === 1) return { ok: true, chainVerified: false };
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i]!;
    const parent = chain[i + 1]!;
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) return { ok: false, reason: "cert_chain_invalid", chainVerified: false };
  }
  const top = chain[chain.length - 1]!;
  const anchored = roots().some((r) => (top.fingerprint256 === r.fingerprint256) || (top.checkIssued(r) && top.verify(r.publicKey)));
  return anchored ? { ok: true, chainVerified: true } : { ok: false, reason: "cert_chain_invalid", chainVerified: false };
}

export type CertFetcher = (url: string) => Promise<string>;

const certCache = new Map<string, string>();
/** HTTPS fetch with a small cache. Only called for allow-listed URLs. */
export const fetchCert: CertFetcher = async (url) => {
  const hit = certCache.get(url);
  if (hit) return hit;
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`cert fetch HTTP ${res.status}`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
};

/** Verify one delivery. Never throws; returns a reason on failure. */
export async function verifyWebhook(input: {
  headers: WebhookHeaders;
  rawBody: Buffer;
  webhookId: string;
  fetcher?: CertFetcher;
  now?: Date;
}): Promise<VerifyResult> {
  const h = input.headers;
  if (!h.transmissionId || !h.transmissionTime || !h.transmissionSig || !h.certUrl) return { valid: false, reason: "missing_headers" };
  if (h.authAlgo && h.authAlgo !== "SHA256withRSA") return { valid: false, reason: "unsupported_algorithm" };
  if (!isAllowedCertUrl(h.certUrl)) return { valid: false, reason: "cert_url_not_allowed" };

  let chain: X509Certificate[];
  try {
    chain = parsePemChain(await (input.fetcher ?? fetchCert)(h.certUrl));
  } catch {
    return { valid: false, reason: "cert_fetch_failed" };
  }
  const chainCheck = checkChain(chain, input.now);
  if (!chainCheck.ok) return { valid: false, reason: chainCheck.reason };

  const message = signedMessage(h.transmissionId, h.transmissionTime, input.webhookId, input.rawBody);
  const ok = verifySignature(message, h.transmissionSig, chain[0]!.publicKey);
  return ok ? { valid: true, chainVerified: chainCheck.chainVerified } : { valid: false, reason: "bad_signature" };
}
