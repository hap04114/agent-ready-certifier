import { describe, expect, it } from "vitest";
import { OWNERSHIP_FILE_PATH, deriveOwnershipToken, tokenFromHtml, verifyOwnership } from "./ownership.js";

const SECRET = "s".repeat(40);
const URL_ = "https://shop.example";
const TOKEN = deriveOwnershipToken(SECRET, URL_);

function site(pages: Record<string, { status?: number; body?: string }>) {
  const seen: { url: string; method?: string; redirect?: string }[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method, redirect: init.redirect });
    const p = pages[new URL(url).pathname];
    if (!p) return new Response("nope", { status: 404 });
    return new Response(p.body ?? "", { status: p.status ?? 200 });
  };
  return { fetcher, seen };
}

describe("ownership tokens", () => {
  it("are stable per origin and differ across stores and secrets", () => {
    expect(TOKEN).toMatch(/^arc-[A-Za-z0-9_-]{32}$/);
    expect(deriveOwnershipToken(SECRET, "https://shop.example/any/path")).toBe(TOKEN);
    expect(deriveOwnershipToken(SECRET, "https://other.example")).not.toBe(TOKEN);
    expect(deriveOwnershipToken("t".repeat(40), URL_)).not.toBe(TOKEN);
  });

  it("are found in meta tags regardless of attribute order and quotes", () => {
    expect(tokenFromHtml(`<meta name="agent-ready-certifier" content="${TOKEN}">`)).toEqual([TOKEN]);
    expect(tokenFromHtml(`<META content='${TOKEN}' NAME=agent-ready-certifier />`)).toEqual([TOKEN]);
    expect(tokenFromHtml(`<meta name="description" content="${TOKEN}">`)).toEqual([]);
  });
});

describe("verifyOwnership", () => {
  it("verifies via the meta tag with a single read-only GET", async () => {
    const { fetcher, seen } = site({ "/": { body: `<html><head><meta name="agent-ready-certifier" content="${TOKEN}"></head></html>` } });
    expect(await verifyOwnership(URL_, TOKEN, fetcher)).toEqual({ verified: true, method: "meta" });
    expect(seen).toEqual([{ url: "https://shop.example/", method: "GET", redirect: "manual" }]);
  });

  it("falls back to the ownership file", async () => {
    const { fetcher } = site({ "/": { body: "<html></html>" }, [OWNERSHIP_FILE_PATH]: { body: `${TOKEN}\n` } });
    expect(await verifyOwnership(URL_, TOKEN, fetcher)).toEqual({ verified: true, method: "file" });
  });

  it("rejects a wrong or missing token, with reasons", async () => {
    const { fetcher } = site({ "/": { body: `<meta name="agent-ready-certifier" content="arc-wrong">` }, [OWNERSHIP_FILE_PATH]: { body: "arc-wrong" } });
    expect(await verifyOwnership(URL_, TOKEN, fetcher)).toEqual({ verified: false, reason: "no matching meta tag on the home page; ownership file does not match" });
  });

  it("does not follow redirects (a redirect could point at someone else's site)", async () => {
    const { fetcher } = site({ "/": { status: 302 } });
    const r = await verifyOwnership(URL_, TOKEN, fetcher);
    expect(r.verified).toBe(false);
    expect(r.verified === false && r.reason).toMatch(/redirects/);
  });

  it("requires https except for localhost", async () => {
    const { fetcher } = site({});
    expect(await verifyOwnership("http://shop.example", TOKEN, fetcher)).toEqual({ verified: false, reason: "store URL must use https (http only for localhost)" });
    expect((await verifyOwnership("not a url", TOKEN, fetcher)).verified).toBe(false);
  });

  it("never throws on network errors", async () => {
    const failing = async () => {
      throw new Error("down");
    };
    expect(await verifyOwnership(URL_, TOKEN, failing)).toEqual({ verified: false, reason: "home page could not be fetched; ownership file could not be fetched" });
  });
});
