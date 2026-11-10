/**
 * Storefront page scan (read-only GETs). Fetches the page and its same-origin scripts, then
 * extracts what the Current and Secure rules need. Cross-origin scripts (e.g. PayPal's SDK)
 * are recorded by URL but not fetched. Secrets are never stored, only masked samples.
 */
import type { SdkGeneration, SecretFinding, StorefrontObservation } from "@certifier/truth";

export interface ScannedFile {
  url: string;
  text: string;
}

export interface PageScan {
  url: string;
  status?: number;
  headers: Record<string, string>;
  html: string;
  files: ScannedFile[];
  scriptSrcs: string[];
  error?: string;
}

const MAX_BYTES = 1024 * 1024;
// Generous: free hosting tiers can take ~50 s to wake a sleeping store.
const MAX_SCRIPTS = 12;

async function getText(fetcher: typeof fetch, url: string): Promise<{ status: number; headers: Record<string, string>; text: string; finalUrl: string }> {
  const res = await fetcher(url, { method: "GET", redirect: "follow", headers: { "user-agent": "agent-ready-certifier/page-scan" }, signal: AbortSignal.timeout(75_000) });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])),
    text: buf.subarray(0, MAX_BYTES).toString("utf8"),
    finalUrl: res.url || url,
  };
}

export function scriptSources(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!).filter((s) => s.trim().length > 0);
}

/** Fetch the page and up to MAX_SCRIPTS same-origin scripts. Never throws. */
export async function scanStorefront(url: string, opts: { fetcher?: typeof fetch; spend?: () => void } = {}): Promise<PageScan> {
  const fetcher = opts.fetcher ?? fetch;
  const spend = opts.spend ?? (() => {});
  const origin = new URL(url).origin;
  try {
    spend();
    const page = await getText(fetcher, url);
    if (new URL(page.finalUrl).origin !== origin) {
      return { url, status: page.status, headers: page.headers, html: "", files: [], scriptSrcs: [], error: "page redirected to another site; not scanned" };
    }
    const srcs = scriptSources(page.text).map((s) => new URL(s, page.finalUrl).toString());
    const files: ScannedFile[] = [{ url, text: page.text }];
    for (const [i, text] of inlineScripts(page.text).entries()) files.push({ url: `${url}#inline-script-${i + 1}`, text });
    for (const src of srcs.filter((s) => new URL(s).origin === origin).slice(0, MAX_SCRIPTS)) {
      try {
        spend();
        const s = await getText(fetcher, src);
        if (s.status < 400) files.push({ url: src, text: s.text });
      } catch {
        // A script that cannot be fetched is simply not scanned.
      }
    }
    return { url, status: page.status, headers: page.headers, html: page.text, files, scriptSrcs: srcs };
  } catch (err) {
    return { url, headers: {}, html: "", files: [], scriptSrcs: [], error: err instanceof Error ? err.name : "fetch failed" };
  }
}

/** Which PayPal integration generation the page loads. */
export function sdkInfo(scriptSrcs: string[]): StorefrontObservation["sdk"] {
  const find = (re: RegExp) => scriptSrcs.find((s) => re.test(s));
  const v6 = find(/^https:\/\/www\.(sandbox\.)?paypal\.com\/web-sdk\/v6\//i);
  if (v6) return { generation: "web-sdk-v6", src: v6, components: [], enableFunding: [] };
  const js = find(/^https:\/\/www\.(sandbox\.)?paypal\.com\/sdk\/js\?/i);
  if (js) {
    const q = new URL(js).searchParams;
    const list = (k: string) => (q.get(k) ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    return { generation: "js-sdk", src: js, components: list("components").length ? list("components") : ["buttons"], enableFunding: list("enable-funding") };
  }
  const legacy = find(/paypalobjects\.com\/api\/checkout(\.min)?\.js/i);
  if (legacy) return { generation: "checkout.js", src: legacy, components: [], enableFunding: [] };
  return { generation: "none" as SdkGeneration, components: [], enableFunding: [] };
}

export function hasPayLaterMarkup(html: string): boolean {
  return /\bdata-pp-message\b/i.test(html) || /<paypal-message/i.test(html) || /\.Messages\s*\(/.test(html);
}

const SECRET_ASSIGNMENT = /(client[_-]?secret|clientSecret|paypal[_-]?secret|PAYPAL_CLIENT_SECRET)["'`]?\s*[:=]\s*["'`]([A-Za-z0-9_-]{20,})["'`]/gi;
const ACCESS_TOKEN = /\bA21AA[A-Za-z0-9_-]{40,}/g;

const mask = (s: string) => `${s.slice(0, 3)}…(${s.length} chars)`;

/** PayPal client secrets and access tokens in public text. Returns masked samples only. */
export function findSecrets(files: ScannedFile[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(SECRET_ASSIGNMENT)) out.push({ file: f.url, kind: "client_secret", masked: mask(m[2]!) });
    for (const m of f.text.matchAll(ACCESS_TOKEN)) out.push({ file: f.url, kind: "access_token", masked: mask(m[0]) });
  }
  return out;
}

/** References to live (non-sandbox) PayPal API hosts in public code. */
export function findLiveHosts(files: ScannedFile[]): { file: string; host: string }[] {
  const out: { file: string; host: string }[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(/\bhttps?:\/\/(api-m|api|api-3t)\.paypal\.com\b/gi)) out.push({ file: f.url, host: `${m[1]!.toLowerCase()}.paypal.com` });
  }
  return out;
}

export function observe(scan: PageScan): StorefrontObservation {
  return { url: scan.url, fetched: scan.status !== undefined && scan.status < 400 && !scan.error, sdk: sdkInfo(scan.scriptSrcs), payLaterMarkup: hasPayLaterMarkup(scan.html) };
}
