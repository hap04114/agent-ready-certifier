import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG, CATALOG_SOURCE } from "./catalog.js";

describe("demo store catalog", () => {
  it("uses the fixed placeholders under test (DEMO_CATALOG=placeholder)", () => {
    expect(CATALOG_SOURCE.kind).toBe("placeholder");
    expect(CATALOG.map((p) => p.sku)).toEqual(["MUG-01", "NOTE-01", "LAMP-01"]);
  });

  it("the committed Channel3 snapshot keeps every SKU, and the price relations the certifier relies on", () => {
    const snap = JSON.parse(readFileSync(fileURLToPath(new URL("./catalog.channel3.json", import.meta.url)), "utf8")) as {
      source: string;
      products: { sku: string; name: string; priceCents: number }[];
    };
    expect(snap.source).toMatch(/Channel3/);
    const price = (sku: string) => snap.products.find((p) => p.sku === sku)!.priceCents;
    // The notebook fits a $20 agent limit; the lamp does not (A2 needs an over-limit item).
    expect(price("NOTE-01")).toBeLessThan(2000);
    expect(price("LAMP-01")).toBeGreaterThan(2000);
    expect(price("MUG-01")).toBeGreaterThan(0);
    // Third-party text is cleaned: no markup characters reach the page.
    for (const p of snap.products) expect(p.name).not.toMatch(/[<>]/);
  });
});
