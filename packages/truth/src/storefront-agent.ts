/**
 * Agent-ready checks on the MERCHANT'S STORE (not on an AI model):
 * - A4 machine-readable price: the price the store publishes as structured data (Schema.org
 *   JSON-LD, read by shopping surfaces such as Google Merchant Center and by any agent that uses
 *   it) equals what PayPal actually charged for that item. A store that publishes none is
 *   inconclusive, not failed: whether AI agents rely on JSON-LD is disputed.
 * - A5 agent-operable checkout: every checkout control has an accessible name, because AI agents
 *   read pages through the same labels and roles that screen readers use.
 * Pure functions over certifier observations and PayPal records. No network, no AI.
 */
import { fmt, sameMoney, toMinorUnits } from "./money.js";
import type { EvidenceRef, MoneySnap, Verdict, VerdictStatus } from "./types.js";

const v = (check: "A4" | "A5", status: VerdictStatus, summary: string, reasons: string[], evidence: EvidenceRef[]): Verdict => ({
  check,
  status,
  summary,
  reasons,
  evidence,
});

// ------------------------------------------------------------------ A4

/** One Schema.org Offer for a Product, as found in the page's JSON-LD. */
export interface StructuredOffer {
  sku?: string;
  name?: string;
  /** Normalised decimal string, e.g. "24.00". */
  price?: string;
  currency?: string;
  availability?: string;
}

/** One item PayPal charged for (from the PayPal order's line items, paypal-api). */
export interface ChargedItem {
  orderId: string;
  sku?: string;
  name?: string;
  unit?: MoneySnap;
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

export function judgeA4(input: { url: string; fetched: boolean; offers: StructuredOffer[]; charged: ChargedItem[] }): Verdict {
  if (!input.fetched) return v("A4", "inconclusive", "The storefront could not be fetched.", [], []);
  const priced = input.offers.filter((o) => o.price !== undefined);
  const pageEv: EvidenceRef = {
    kind: "page",
    id: input.url,
    strength: "certifier-observed",
    note: priced.length ? `structured offers: ${priced.slice(0, 6).map((o) => `${o.sku ?? o.name ?? "?"} ${o.price} ${o.currency ?? "?"}`).join("; ")}` : "no Schema.org Product with an Offer price in the page",
  };
  // No published machine-readable price: nothing to contradict PayPal, and whether AI agents
  // rely on JSON-LD is disputed, so this is reported, not failed.
  if (priced.length === 0) {
    return v(
      "A4",
      "inconclusive",
      "The store publishes no machine-readable price (no Schema.org Product with an Offer price).",
      ["Nothing to compare with PayPal's charge. Shopping surfaces such as Google Merchant Center read this data to check landing-page prices."],
      [pageEv],
    );
  }
  const charged = input.charged.filter((c) => c.unit);
  if (charged.length === 0) return v("A4", "inconclusive", "No PayPal charge was available to compare with.", [], [pageEv]);

  const pairs = charged.flatMap((c) => {
    const offer = priced.find((o) => c.sku && norm(o.sku) === norm(c.sku)) ?? priced.find((o) => c.name && norm(o.name) === norm(c.name));
    return offer ? [{ c, offer }] : [];
  });
  const orderEv = (c: ChargedItem): EvidenceRef => ({ kind: "order", id: c.orderId, strength: "paypal-api", note: `${c.sku ?? c.name ?? "item"} charged ${fmt(c.unit)} per unit` });
  if (pairs.length === 0) {
    return v("A4", "inconclusive", "The structured offers could not be matched to the items PayPal charged.", ["No offer shares a SKU or exact name with a charged item."], [pageEv, ...charged.map(orderEv)]);
  }
  const mismatched = pairs.filter(({ c, offer }) => {
    if (toMinorUnits(offer.price) === undefined) return true;
    if (offer.currency) return !sameMoney({ value: offer.price!, currencyCode: offer.currency }, c.unit);
    return toMinorUnits(offer.price) !== toMinorUnits(c.unit!.value);
  });
  const evidence = [pageEv, ...pairs.map(({ c }) => orderEv(c))];
  if (mismatched.length) {
    return v(
      "A4",
      "fail",
      "The store's machine-readable price differs from what PayPal charges.",
      mismatched.map(({ c, offer }) => `${c.sku ?? c.name}: structured data says ${offer.price} ${offer.currency ?? "(no currency)"}, PayPal order ${c.orderId} charged ${fmt(c.unit)}.`),
      evidence,
    );
  }
  return v("A4", "pass", `The machine-readable price matches what PayPal charged (${pairs.length} item${pairs.length === 1 ? "" : "s"}).`, [], evidence);
}

// ------------------------------------------------------------------ A5

/** Raw facts about one visible interactive control on the store's own page (no input values). */
export interface ControlFacts {
  tag: string;
  type?: string;
  role?: string;
  ariaLabel?: string;
  labelledbyText?: string;
  /** Text of <label> elements associated with the control. */
  labelText?: string;
  /** For input type=submit/button/reset only (their visible caption). */
  buttonValue?: string;
  alt?: string;
  title?: string;
  placeholder?: string;
  /** Visible text of buttons and links. */
  text?: string;
  /** Alt / title of an image or svg inside the control. */
  innerImgName?: string;
  /** Short identifier for the report, e.g. 'select#sku' or 'button.cart'. */
  hint: string;
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * Simplified accessible-name computation (WAI-ARIA accname order): aria-labelledby, aria-label,
 * associated label, button caption / alt, contents, title, placeholder.
 */
export function accessibleName(c: ControlFacts): string {
  for (const s of [c.labelledbyText, c.ariaLabel, c.labelText, c.buttonValue, c.alt, c.text, c.innerImgName, c.title, c.placeholder]) {
    const t = clean(s);
    if (t) return t;
  }
  return "";
}

export function judgeA5(input: { url: string; controls?: ControlFacts[] }): Verdict {
  if (!input.controls) return v("A5", "inconclusive", "No browser measurement available.", [], []);
  if (input.controls.length === 0) return v("A5", "inconclusive", "No interactive controls were found on the store's page.", [], []);
  const unnamed = input.controls.filter((c) => !accessibleName(c));
  const ev: EvidenceRef[] = [
    { kind: "page", id: input.url, strength: "certifier-observed", note: `${input.controls.length} controls checked; ${unnamed.length} without an accessible name${unnamed.length ? `: ${unnamed.slice(0, 6).map((c) => c.hint).join(", ")}` : ""}` },
  ];
  if (unnamed.length) {
    return v(
      "A5",
      "fail",
      `${unnamed.length} checkout control${unnamed.length === 1 ? " has" : "s have"} no accessible name, so AI agents (and screen readers) can't tell what ${unnamed.length === 1 ? "it does" : "they do"}.`,
      unnamed.slice(0, 8).map((c) => `${c.hint}: no label, aria-label or visible text.`),
      ev,
    );
  }
  return v("A5", "pass", `All ${input.controls.length} checkout controls have accessible names.`, [], ev);
}
