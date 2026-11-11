/**
 * `pnpm --filter @certifier/demo-stores catalog:sync` — fill the demo stores with REAL products
 * from Channel3 (product search API). Writes a committed snapshot (catalog.channel3.json), so the
 * hosted stores never need the key. Each slot keeps its SKU and a price band, because the
 * certifier's tests rely on the relations (e.g. the notebook fits a $20 agent limit, the lamp
 * does not). Third-party product text is untrusted: only title, brand, price, image URL and the
 * Channel3 ID are kept, cleaned and length-capped. The key is never printed.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootConfig } from "@certifier/config";
import { z } from "zod";

const SLOTS = [
  { sku: "MUG-01", query: "stoneware coffee mug", minCents: 1200, maxCents: 3500 },
  { sku: "NOTE-01", query: "A5 dotted notebook", minCents: 800, maxCents: 1900 },
  { sku: "LAMP-01", query: "LED desk lamp", minCents: 2500, maxCents: 8000 },
] as const;

const product = z.object({
  id: z.string(),
  title: z.string(),
  brands: z.array(z.object({ name: z.string().optional() }).passthrough()).optional(),
  images: z.array(z.object({ url: z.string().optional() }).passthrough()).optional(),
  offers: z.array(z.object({ price: z.object({ price: z.number(), currency: z.string() }).passthrough(), url: z.string().optional() }).passthrough()).optional(),
});

// Keep printable characters only (control characters and markup become spaces).
const clean = (s: string, max: number) =>
  [...s]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === "<" || ch === ">" ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const config = bootConfig("catalog:sync");
const key = config.CHANNEL3_API_KEY;
if (!key) {
  console.error("catalog:sync: CHANNEL3_API_KEY is empty in .env");
  process.exit(1);
}

const out = [];
for (const slot of SLOTS) {
  const res = await fetch("https://api.trychannel3.com/v1/search", {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ query: slot.query, limit: 20 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.error(`catalog:sync: Channel3 answered HTTP ${res.status} for "${slot.query}"`);
    process.exit(1);
  }
  const products = z.object({ products: z.array(z.unknown()) }).parse(await res.json()).products;
  const pick = products
    .map((p) => product.safeParse(p))
    .filter((r) => r.success)
    .map((r) => r.data)
    .map((p) => ({ p, offer: p.offers?.find((o) => o.price.currency === "USD") }))
    .find(({ offer }) => offer && Math.round(offer.price.price * 100) >= slot.minCents && Math.round(offer.price.price * 100) <= slot.maxCents);
  if (!pick?.offer) {
    console.error(`catalog:sync: no USD product in the price band for "${slot.query}"`);
    process.exit(1);
  }
  const brand = pick.p.brands?.[0]?.name;
  out.push({
    sku: slot.sku,
    name: clean(pick.p.title, 90),
    brand: brand ? clean(brand, 40) : undefined,
    priceCents: Math.round(pick.offer.price.price * 100),
    imageUrl: pick.p.images?.[0]?.url?.startsWith("https://") ? pick.p.images[0].url.slice(0, 500) : undefined,
    channel3Id: clean(pick.p.id, 80),
  });
  console.log(`${slot.sku}: ${out.at(-1)!.name} — $${(out.at(-1)!.priceCents / 100).toFixed(2)}`);
}

const file = fileURLToPath(new URL("./catalog.channel3.json", import.meta.url));
writeFileSync(file, `${JSON.stringify({ source: "Channel3 product search API", fetchedAt: new Date().toISOString(), products: out }, null, 2)}\n`);
console.log("catalog:sync: wrote catalog.channel3.json");
