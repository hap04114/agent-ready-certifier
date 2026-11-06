/**
 * PLACEHOLDER CATALOG. These are hand-written stand-ins until Channel3 product data is
 * wired in (needs CHANNEL3_API_KEY). The UI labels them as placeholders.
 *
 * Prices are integer cents and live only on the server: the browser sends a SKU and a
 * quantity, never a price (this is what S1 checks).
 */
export interface Product {
  sku: string;
  name: string;
  priceCents: number;
}

export const CATALOG: readonly Product[] = [
  { sku: "MUG-01", name: "Stoneware coffee mug (placeholder)", priceCents: 2400 },
  { sku: "NOTE-01", name: "A5 dotted notebook (placeholder)", priceCents: 1250 },
  { sku: "LAMP-01", name: "Desk lamp (placeholder)", priceCents: 5000 },
];

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
