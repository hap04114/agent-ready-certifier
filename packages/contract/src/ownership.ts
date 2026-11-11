/**
 * Ownership verification (CLAUDE.md rule 3): no probe runs against a store until it serves the
 * ownership token the certifier issued for its origin. The token is PUBLIC by design (like a
 * domain-verification token); it proves control of the store, it does not protect anything.
 *
 * Accepted placements (either one):
 *   <meta name="agent-ready-certifier" content="<token>">   on the store's home page
 *   GET /.well-known/certifier/ownership.txt                 whose body is the token
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const CONTRACT_BASE = "/.well-known/certifier";
const storeOrigin = (url: string) => new URL(url).origin.toLowerCase();

export const OWNERSHIP_META_NAME = "agent-ready-certifier";
export const OWNERSHIP_FILE_PATH = `${CONTRACT_BASE}/ownership.txt`;
const MAX_BYTES = 256 * 1024;

/** Public ownership token for a store origin: "arc-" + HMAC-SHA256(secret, "ownership:v1:" + origin). */
export function deriveOwnershipToken(secret: string, storeUrl: string): string {
  if (secret.length < 32) throw new Error("OWNERSHIP_TOKEN_SECRET must be at least 32 characters");
  return `arc-${createHmac("sha256", secret).update(`ownership:v1:${storeOrigin(storeUrl)}`).digest("base64url").slice(0, 32)}`;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Find the token in a page's meta tags. Attribute order and quoting may vary. */
export function tokenFromHtml(html: string): string[] {
  const found: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? /\bcontent\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (name?.toLowerCase() === OWNERSHIP_META_NAME && content) found.push(content.trim());
  }
  return found;
}

export type OwnershipResult =
  | { verified: true; method: "meta" | "file" }
  | { verified: false; reason: string };

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Read at most MAX_BYTES of a response body as text. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.length;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Check a store for its token. Read-only HTTP GETs only (two at most), short timeouts,
 * capped bodies, and no redirects to other origins. Never throws.
 */
export async function verifyOwnership(
  storeUrl: string,
  expected: string,
  fetcher: Fetcher = fetch,
  /** Per-request timeout. Free hosting tiers can take ~50 s to wake a sleeping store. */
  timeoutMs = 75_000,
): Promise<OwnershipResult> {
  let origin: string;
  try {
    origin = storeOrigin(storeUrl);
  } catch {
    return { verified: false, reason: "invalid store URL" };
  }
  if (!origin.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return { verified: false, reason: "store URL must use https (http only for localhost)" };
  }
  const get = async (path: string) => {
    const res = await fetcher(new URL(path, origin).toString(), {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "agent-ready-certifier/ownership-check" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res;
  };
  const reasons: string[] = [];
  try {
    const page = await get("/");
    if (page.status >= 300 && page.status < 400) reasons.push(`home page redirects (HTTP ${page.status}); serve the token without a redirect`);
    else if (!page.ok) reasons.push(`home page answered HTTP ${page.status}`);
    else if (tokenFromHtml(await readCapped(page)).some((t) => same(t, expected))) return { verified: true, method: "meta" };
    else reasons.push("no matching meta tag on the home page");
  } catch {
    reasons.push("home page could not be fetched");
  }
  try {
    const file = await get(OWNERSHIP_FILE_PATH);
    if (file.ok && same((await readCapped(file)).trim(), expected)) return { verified: true, method: "file" };
    reasons.push(file.ok ? "ownership file does not match" : `ownership file answered HTTP ${file.status}`);
  } catch {
    reasons.push("ownership file could not be fetched");
  }
  return { verified: false, reason: reasons.join("; ") };
}
