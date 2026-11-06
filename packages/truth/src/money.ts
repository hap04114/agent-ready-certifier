import type { MoneySnap } from "./types.js";

/** "24.00" -> 2400; undefined for anything that is not a plain non-negative decimal. */
export function toMinorUnits(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+(\.\d{1,2})?$/.test(value)) return undefined;
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Same currency and same amount in minor units. Unknown values never match. */
export function sameMoney(a: MoneySnap | undefined, b: MoneySnap | undefined): boolean {
  if (!a || !b) return false;
  const x = toMinorUnits(a.value);
  const y = toMinorUnits(b.value);
  return x !== undefined && x === y && a.currencyCode.toUpperCase() === b.currencyCode.toUpperCase();
}

export const fmt = (m: MoneySnap | undefined) => (m ? `${m.value} ${m.currencyCode}` : "unknown");
