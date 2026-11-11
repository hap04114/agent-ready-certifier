/**
 * The demo stores' catalog. By default: REAL products from Channel3 (a committed snapshot written
 * by `pnpm --filter @certifier/demo-stores catalog:sync`). Feature switch: DEMO_CATALOG=placeholder
 * uses the hand-written stand-ins instead (the tests do, so their prices stay fixed).
 *
 * Prices are integer cents and live only on the server: the browser sends a SKU and a
 * quantity, never a price (this is what S1 checks).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  brand?: string;
  imageUrl?: string;
  channel3Id?: string;
}

const PLACEHOLDERS: readonly Product[] = [
  { sku: "MUG-01", name: "Stoneware coffee mug (placeholder)", priceCents: 2400 },
  { sku: "NOTE-01", name: "A5 dotted notebook (placeholder)", priceCents: 1250 },
  { sku: "LAMP-01", name: "Desk lamp (placeholder)", priceCents: 5000 },
];

const snapshot = z.object({
  source: z.string(),
  fetchedAt: z.string(),
  products: z.array(
    z.object({
      sku: z.string(),
      name: z.string().max(120),
      priceCents: z.number().int().positive(),
      brand: z.string().max(60).optional(),
      imageUrl: z.string().url().optional(),
      channel3Id: z.string().max(100).optional(),
    }),
  ),
});

function loadChannel3(): { products: Product[]; fetchedAt: string } | undefined {
  if (process.env.DEMO_CATALOG === "placeholder") return undefined;
  try {
    const raw = readFileSync(fileURLToPath(new URL("./catalog.channel3.json", import.meta.url)), "utf8");
    const parsed = snapshot.parse(JSON.parse(raw));
    // Every placeholder SKU must be present: the certifier's tests address products by SKU.
    if (!PLACEHOLDERS.every((p) => parsed.products.some((q) => q.sku === p.sku))) return undefined;
    return { products: parsed.products, fetchedAt: parsed.fetchedAt };
  } catch {
    return undefined;
  }
}

const real = loadChannel3();
export const CATALOG: readonly Product[] = real?.products ?? PLACEHOLDERS;
/** Where the catalog came from, for the store's banner and /api/catalog. */
export const CATALOG_SOURCE: { kind: "channel3"; fetchedAt: string } | { kind: "placeholder" } = real ? { kind: "channel3", fetchedAt: real.fetchedAt } : { kind: "placeholder" };

export const CURRENCY = "USD";
export const MAX_QUANTITY = 10;

export function findProduct(sku: string): Product | undefined {
  return CATALOG.find((p) => p.sku === sku);
}

/** 2400 -> "24.00" */
export function centsToValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("invalid cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "24.00" -> 2400. Returns undefined for anything that is not a plain 2-decimal amount. */
export function valueToCents(value: string | undefined): number | undefined {
  if (!value || !/^\d+(\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
