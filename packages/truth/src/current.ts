/**
 * Current pillar rules C1–C5: does the store follow PayPal's growth playbook?
 * Pure functions over what the certifier observed on the public storefront.
 */
import type { EvidenceRef, Verdict, VerdictStatus } from "./types.js";

type CurrentCode = "C1" | "C2" | "C3" | "C4" | "C5";
const v = (check: CurrentCode, status: VerdictStatus, summary: string, reasons: string[], evidence: EvidenceRef[]): Verdict => ({
  check,
  status,
  summary,
  reasons,
  evidence,
});

export type SdkGeneration = "web-sdk-v6" | "js-sdk" | "checkout.js" | "none";

export interface StorefrontObservation {
  url: string;
  fetched: boolean;
  sdk: { generation: SdkGeneration; src?: string; components: string[]; enableFunding: string[] };
  /** A pay-later message placeholder (data-pp-message / paypal-messages) is in the page. */
  payLaterMarkup: boolean;
  /** The button-integrated Pay Later message (paypal.Buttons({ message })) is configured in a page script. */
  buttonsMessage?: boolean;
  /** From a real browser, when available. */
  rendered?: {
    viewport: { width: number; height: number };
    /** Top and bottom of the PayPal button, in CSS pixels from the top of the page. */
    paypalButton?: { top: number; bottom: number };
    payLaterMessageRendered?: boolean;
    venmoButtonRendered?: boolean;
    /** A5: the store's own visible interactive controls (PayPal's iframes excluded). */
    controls?: import("./storefront-agent.js").ControlFacts[];
  };
}

const pageRef = (o: StorefrontObservation, note: string): EvidenceRef => ({ kind: "page", id: o.url, strength: "certifier-observed", note });

// C1 SDK generation: the current JavaScript SDK or Web SDK v6, not the legacy checkout.js.
export function judgeC1(o: StorefrontObservation): Verdict {
  if (!o.fetched) return v("C1", "inconclusive", "The storefront could not be fetched.", [], []);
  const ev = [pageRef(o, o.sdk.src ? `PayPal script: ${o.sdk.src.split("?")[0]}` : "no PayPal script found")];
  switch (o.sdk.generation) {
    case "web-sdk-v6":
      return v("C1", "pass", "Uses PayPal's Web SDK v6.", [], ev);
    case "js-sdk":
      return v("C1", "pass", "Uses PayPal's current JavaScript SDK.", [], ev);
    case "checkout.js":
      return v("C1", "fail", "Uses the legacy checkout.js integration.", ["checkout.js is deprecated; current PayPal features (Pay Later, Venmo, saved methods) need the JS SDK or Web SDK v6."], ev);
    default:
      return v("C1", "inconclusive", "No PayPal SDK found on the page.", [], ev);
  }
}

// C2 Pay Later messaging on the product or cart page.
export function judgeC2(o: StorefrontObservation): Verdict {
  if (!o.fetched) return v("C2", "inconclusive", "The storefront could not be fetched.", [], []);
  if (o.sdk.generation === "none") return v("C2", "inconclusive", "No PayPal SDK found on the page.", [], []);
  const hasComponent = o.sdk.components.includes("messages") || o.sdk.generation === "web-sdk-v6";
  const rendered = o.rendered?.payLaterMessageRendered;
  const ev = [
    pageRef(
      o,
      `messages component ${hasComponent ? "loaded" : "not loaded"}; message markup ${o.payLaterMarkup ? "present" : "absent"}; button-integrated message ${o.buttonsMessage ? "configured" : "not configured"}${rendered === undefined ? "" : `; rendered: ${rendered ? "yes" : "no"}`}`,
    ),
  ];
  // Either the messages component with a placement, or the button-integrated message (Buttons({ message })).
  if (rendered === true || (hasComponent && o.payLaterMarkup) || o.buttonsMessage) return v("C2", "pass", "Pay Later messaging is shown to shoppers.", [], ev);
  return v("C2", "fail", "No Pay Later messaging on the page.", [
    !hasComponent ? 'The PayPal SDK is loaded without the "messages" component.' : "No Pay Later message placement on the page.",
  ], ev);
}

// C3 PayPal button visible without scrolling.
export function judgeC3(o: StorefrontObservation): Verdict {
  const r = o.rendered;
  if (!r) return v("C3", "inconclusive", "No browser measurement available.", [], []);
  if (!r.paypalButton) return v("C3", "inconclusive", "No PayPal button was rendered on the page.", [], []);
  const visible = r.paypalButton.top < r.viewport.height;
  const ev = [pageRef(o, `button top ${Math.round(r.paypalButton.top)}px; viewport ${r.viewport.width}×${r.viewport.height}`)];
  return visible
    ? v("C3", "pass", "The PayPal button is visible without scrolling.", [], ev)
    : v("C3", "fail", "The PayPal button is below the fold.", [`The button starts ${Math.round(r.paypalButton.top - r.viewport.height)}px below the first screen.`], ev);
}

// C4 Saved PayPal method offered to returning buyers, where configured.
export function judgeC4(input: { configured: boolean; offered?: boolean; url: string }): Verdict {
  if (!input.configured) {
    return v("C4", "inconclusive", "Saved payment methods are not configured for this store (not applicable).", [], []);
  }
  const ev: EvidenceRef[] = [{ kind: "page", id: input.url, strength: "certifier-observed", note: `saved method offered: ${input.offered ? "yes" : "no"}` }];
  return input.offered ? v("C4", "pass", "Returning buyers are offered their saved PayPal method.", [], ev) : v("C4", "fail", "Saved methods are configured but not offered.", [], ev);
}

// C5 Venmo offered. "Not offered" is not applicable, never a failure (Venmo is US-only and
// shown only to eligible buyers and devices).
export function judgeC5(o: StorefrontObservation): Verdict {
  if (!o.fetched) return v("C5", "inconclusive", "The storefront could not be fetched.", [], []);
  const enabled = o.sdk.enableFunding.includes("venmo");
  const rendered = o.rendered?.venmoButtonRendered;
  const ev = [pageRef(o, `enable-funding: ${o.sdk.enableFunding.join(",") || "none"}${rendered === undefined ? "" : `; Venmo button rendered: ${rendered ? "yes" : "no"}`}`)];
  if (enabled || rendered) return v("C5", "pass", rendered ? "Venmo is offered and shown." : "Venmo is enabled for eligible buyers.", [], ev);
  return v("C5", "inconclusive", "Venmo is not offered (not applicable).", [], ev);
}
