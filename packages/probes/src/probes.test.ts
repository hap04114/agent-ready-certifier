import { describe, expect, it } from "vitest";
import { findLiveHosts, findSecrets, hasPayLaterMarkup, inlineScripts, observe, scanStorefront, scriptSources, sdkInfo } from "./page.js";
import { TAMPER_FIELDS, probeS1, probeS2 } from "./store.js";

const SECRET = "EHfAKEsEcReTvAlUe0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR_-0123";

function site(files: Record<string, { status?: number; body: string; headers?: Record<string, string> }>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const f = files[new URL(url).pathname];
    if (!f) return new Response("missing", { status: 404 });
    return new Response(f.body, { status: f.status ?? 200, headers: f.headers });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

describe("page analysis", () => {
  it("recognises SDK generations, components and funding", () => {
    expect(sdkInfo(["https://www.paypal.com/sdk/js?client-id=A&components=buttons,messages&enable-funding=paylater,venmo"])).toEqual({
      generation: "js-sdk",
      src: "https://www.paypal.com/sdk/js?client-id=A&components=buttons,messages&enable-funding=paylater,venmo",
      components: ["buttons", "messages"],
      enableFunding: ["paylater", "venmo"],
    });
    expect(sdkInfo(["https://www.paypal.com/sdk/js?client-id=A"]).components).toEqual(["buttons"]);
    expect(sdkInfo(["https://www.paypalobjects.com/api/checkout.js"]).generation).toBe("checkout.js");
    expect(sdkInfo(["https://www.sandbox.paypal.com/web-sdk/v6/core"]).generation).toBe("web-sdk-v6");
    expect(sdkInfo(["https://cdn.example/app.js"]).generation).toBe("none");
  });

  it("finds script tags and inline scripts", () => {
    const html = `<script src="/a.js?x=1&amp;y=2"></script><script>var x = 1;</script><script type="module" src='b.js'></script>`;
    expect(scriptSources(html)).toEqual(["/a.js?x=1&y=2", "b.js"]);
    expect(inlineScripts(html)).toEqual(["var x = 1;"]);
  });

  it("detects Pay Later markup", () => {
    expect(hasPayLaterMarkup('<div data-pp-message data-pp-amount="1"></div>')).toBe(true);
    expect(hasPayLaterMarkup("<div></div>")).toBe(false);
  });

  it("finds exposed secrets and tokens, masked, and ignores the public client ID", () => {
    const files = [
      { url: "https://s/config.js", text: `window.PAYPAL = { clientId: "AYv0public", clientSecret: "${SECRET}" };` },
      { url: "https://s/x.js", text: 'fetch(u, { headers: { Authorization: "Bearer A21AAKqz0123456789abcdefghijklmnopqrstuvwxyzABCDEF" } })' },
      { url: "https://s/ok.js", text: 'paypal.Buttons({ clientId: "AYv0public" })' },
    ];
    const found = findSecrets(files);
    expect(found).toEqual([
      { file: "https://s/config.js", kind: "client_secret", masked: `EHf…(${SECRET.length} chars)` },
      { file: "https://s/x.js", kind: "access_token", masked: "A21…(50 chars)" },
    ]);
    expect(JSON.stringify(found)).not.toContain(SECRET);
  });

  it("flags live API hosts but not sandbox ones", () => {
    expect(findLiveHosts([{ url: "f", text: "https://api-m.paypal.com/v2 https://api-m.sandbox.paypal.com/v2" }])).toEqual([{ file: "f", host: "api-m.paypal.com" }]);
  });
});

describe("scanStorefront", () => {
  it("fetches the page and same-origin scripts only, never cross-origin", async () => {
    const { fetcher, seen } = site({
      "/": { body: '<script src="https://www.paypal.com/sdk/js?client-id=A"></script><script src="/app.js"></script>', headers: { "content-security-policy": "x" } },
      "/app.js": { body: "console.log(1)" },
    });
    const scan = await scanStorefront("https://shop.example/", { fetcher });
    expect(seen.map((s) => s.url)).toEqual(["https://shop.example/", "https://shop.example/app.js"]);
    expect(scan.files.map((f) => f.url)).toEqual(["https://shop.example/", "https://shop.example/app.js"]);
    expect(scan.headers["content-security-policy"]).toBe("x");
    expect(observe(scan)).toMatchObject({ fetched: true, sdk: { generation: "js-sdk" } });
  });

  it("never throws", async () => {
    const failing = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect((await scanStorefront("https://shop.example/", { fetcher: failing })).error).toBe("Error");
  });
});

describe("store probes", () => {
  const target = { url: "https://shop.example", statusKey: "k" };

  it("S1 sends every common price field set to the tamper value", async () => {
    const { fetcher, seen } = site({ "/api/orders": { status: 201, body: '{"id":"ORDER1"}' } });
    const r = await probeS1(target, { fetcher }, { sku: "LAMP", price: "50.00", currency: "USD" });
    expect(r).toMatchObject({ status: 201, id: "ORDER1", rejected: false });
    const body = JSON.parse(String(seen[0]!.init.body));
    for (const f of TAMPER_FIELDS) expect(body[f]).toBe("1.00");
  });

  it("S2 sends an event without a valid PayPal signature", async () => {
    const { fetcher, seen } = site({ "/webhooks/paypal": { status: 400, body: "{}" } });
    const r = await probeS2(target, { fetcher }, "ORDER1", { currencyCode: "USD", value: "50.00" });
    expect(r).toEqual({ sent: true, storeHttpStatus: 400 });
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["paypal-cert-url"]).not.toMatch(/paypal\.com/);
    expect(JSON.parse(String(seen[0]!.init.body)).resource.supplementary_data.related_ids.order_id).toBe("ORDER1");
  });
});
