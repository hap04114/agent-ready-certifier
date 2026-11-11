import { describe, expect, it } from "vitest";
import { structuredOffers } from "./page.js";

const page = (...blocks: string[]) => `<html><head>${blocks.map((b) => `<script type="application/ld+json">${b}</script>`).join("")}</head><body></body></html>`;

describe("structuredOffers (A4)", () => {
  it("reads Product offers, normalising price and currency", () => {
    const html = page(JSON.stringify({ "@context": "https://schema.org", "@type": "Product", sku: "MUG-01", name: "Mug", offers: { "@type": "Offer", price: 24, priceCurrency: "usd", availability: "https://schema.org/InStock" } }));
    expect(structuredOffers(html)).toEqual([{ sku: "MUG-01", name: "Mug", price: "24.00", currency: "USD", availability: "https://schema.org/InStock" }]);
  });

  it("finds products inside @graph and ItemList, with several offers", () => {
    const html = page(
      JSON.stringify({ "@graph": [{ "@type": "WebSite" }, { "@type": ["Product"], sku: "A", offers: [{ price: "1.5", priceCurrency: "USD" }, { price: "2.00", priceCurrency: "USD" }] }] }),
      JSON.stringify({ "@type": "ItemList", itemListElement: [{ "@type": "ListItem", item: { "@type": "Product", sku: "B", offers: { price: "3.00", priceCurrency: "USD" } } }] }),
    );
    expect(structuredOffers(html).map((o) => `${o.sku}:${o.price}`)).toEqual(["A:1.50", "A:2.00", "B:3.00"]);
  });

  it("records a Product without a usable price, and never treats an AggregateOffer range as a price", () => {
    const html = page(
      JSON.stringify({ "@type": "Product", sku: "NOPRICE" }),
      JSON.stringify({ "@type": "Product", sku: "RANGE", offers: { "@type": "AggregateOffer", lowPrice: "5.00", priceCurrency: "USD" } }),
      JSON.stringify({ "@type": "Product", sku: "TEXT", offers: { price: "call us", priceCurrency: "USD" } }),
    );
    expect(structuredOffers(html).every((o) => o.price === undefined)).toBe(true);
  });

  it("skips malformed JSON and pages without structured data", () => {
    expect(structuredOffers(page("{not json"))).toEqual([]);
    expect(structuredOffers("<html><body>no data</body></html>")).toEqual([]);
  });
});
