/**
 * Secure pillar rules S1–S8. Pure functions over observations; no network, no AI.
 * Missing data yields "inconclusive", never a guessed pass.
 */
import { fmt, sameMoney, toMinorUnits } from "./money.js";
import type { DuplicateDelivery } from "./works.js";
import { judgeW6 } from "./works.js";
import type { EvidenceRef, MoneySnap, PaypalOrderSnap, StoreRecordSnap, Verdict, VerdictStatus } from "./types.js";

type SecureCode = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";
const v = (check: SecureCode, status: VerdictStatus, summary: string, reasons: string[], evidence: EvidenceRef[]): Verdict => ({
  check,
  status,
  summary,
  reasons,
  evidence,
});
const orderRef = (o: PaypalOrderSnap, note?: string): EvidenceRef => ({ kind: "order", id: o.id, strength: "paypal-api", note: note ?? `status ${o.status}, ${fmt(o.amount)}` });
const storeRef = (s: StoreRecordSnap): EvidenceRef => ({ kind: "store_record", id: s.paypalOrderId, strength: "store-reported", note: `status ${s.status}` });
const completedCaptures = (o: PaypalOrderSnap) => o.captures.filter((c) => c.status === "COMPLETED");

// S1 Price tampering: PayPal order amount equals the store's server price after the
// page-sent price was altered.
export function judgeS1(input: {
  /** The store's own price for the item (store-reported catalog). */
  serverPrice?: MoneySnap;
  /** The value the probe put into the request's price fields. */
  tamperedValue: string;
  tamperedFields: string[];
  /** The PayPal order the store created from the tampered request (paypal-api). */
  order?: PaypalOrderSnap;
  storeRejected?: boolean;
}): Verdict {
  if (input.storeRejected) return v("S1", "pass", "Store rejected the tampered checkout request.", [], []);
  if (!input.order) return v("S1", "inconclusive", "No PayPal order was created from the tampered request.", [], []);
  const evidence = [orderRef(input.order)];
  if (!input.serverPrice) return v("S1", "inconclusive", "The store's server price is unavailable.", [], evidence);
  evidence.push({ kind: "store_record", id: "catalog", strength: "store-reported", note: `server price ${fmt(input.serverPrice)}` });
  if (sameMoney(input.order.amount, input.serverPrice)) {
    return v("S1", "pass", `PayPal charged the server price (${fmt(input.serverPrice)}), not the tampered ${input.tamperedValue}.`, [], evidence);
  }
  const paid = toMinorUnits(input.order.amount?.value) ?? -1;
  const server = toMinorUnits(input.serverPrice.value) ?? -1;
  return v("S1", "fail", "The store trusted the price sent by the browser.", [
    `PayPal order ${input.order.id} is for ${fmt(input.order.amount)}, but the store's price is ${fmt(input.serverPrice)}${paid < server ? " (undercharged)" : ""}.`,
    `Tampered request fields: ${input.tamperedFields.join(", ")} = ${input.tamperedValue}.`,
  ], evidence);
}

// S2 Forged webhook: an unsigned or mis-signed event changes nothing.
export function judgeS2(input: { sent: boolean; storeHttpStatus?: number; before?: StoreRecordSnap; after?: StoreRecordSnap; order?: PaypalOrderSnap }): Verdict {
  if (!input.sent) return v("S2", "inconclusive", "The forged event could not be sent.", [], []);
  const { before, after, order } = input;
  if (!before || !after) return v("S2", "inconclusive", "Store record unavailable.", [], []);
  const evidence: EvidenceRef[] = [{ kind: "webhook_event", id: "forged", strength: "certifier-observed", note: `forged event (no valid PayPal signature); store answered HTTP ${input.storeHttpStatus ?? "?"}` }, storeRef(after)];
  if (order) evidence.push(orderRef(order));
  const reasons: string[] = [];
  if (after.status !== before.status) reasons.push(`Store changed the order from "${before.status}" to "${after.status}" because of an unsigned event.`);
  if (after.fulfilmentCount !== before.fulfilmentCount) reasons.push(`Fulfilments changed from ${before.fulfilmentCount} to ${after.fulfilmentCount}.`);
  if (order && completedCaptures(order).length === 0 && after.status === "paid") reasons.push("PayPal shows no capture for this order: the store would ship an unpaid order.");
  return reasons.length === 0
    ? v("S2", "pass", "The store ignored a forged, unsigned webhook.", [], evidence)
    : v("S2", "fail", "The store accepted a forged webhook.", reasons, evidence);
}

// S3 Webhook replay: a valid event replayed is processed once. Same observations as W6,
// judged from the security angle.
export function judgeS3(input: { duplicates: DuplicateDelivery[]; before?: StoreRecordSnap; after?: StoreRecordSnap; notes?: string[] }): Verdict {
  const w6 = judgeW6(input);
  const summary =
    w6.status === "pass" ? "A replayed PayPal-signed event was processed only once." : w6.status === "fail" ? "A replayed event was processed again (replay attack)." : w6.summary;
  return { ...w6, check: "S3", summary };
}

// S4 Order replay: a second capture is refused and nothing ships twice.
export function judgeS4(input: { secondCaptureHttpStatus?: number; order?: PaypalOrderSnap; before?: StoreRecordSnap; after?: StoreRecordSnap }): Verdict {
  const { order, before, after } = input;
  if (!order || completedCaptures(order).length === 0) return v("S4", "inconclusive", "No captured order to replay.", [], order ? [orderRef(order)] : []);
  if (!before || !after) return v("S4", "inconclusive", "Store record unavailable.", [], [orderRef(order)]);
  const evidence = [orderRef(order, `${completedCaptures(order).length} completed capture(s)`), storeRef(after)];
  const reasons: string[] = [];
  if (completedCaptures(order).length > 1) reasons.push(`PayPal shows ${completedCaptures(order).length} captures for one order.`);
  if (after.fulfilmentCount > before.fulfilmentCount) reasons.push(`The store fulfilled the order again (${before.fulfilmentCount} → ${after.fulfilmentCount}).`);
  if (input.secondCaptureHttpStatus !== undefined && input.secondCaptureHttpStatus >= 200 && input.secondCaptureHttpStatus < 300) {
    reasons.push(`The store reported success (HTTP ${input.secondCaptureHttpStatus}) for a second capture.`);
  }
  return reasons.length === 0
    ? v("S4", "pass", "A second capture was refused and nothing shipped twice.", [], evidence)
    : v("S4", "fail", "The store processed an order replay.", reasons, evidence);
}

export interface SecretFinding {
  file: string;
  kind: "client_secret" | "access_token";
  /** Masked sample, never the full value. */
  masked: string;
}

// S5 Exposed secrets: no client secret or access token in public pages or scripts.
export function judgeS5(input: { scanned: string[]; findings: SecretFinding[] }): Verdict {
  if (input.scanned.length === 0) return v("S5", "inconclusive", "No public page or script could be scanned.", [], []);
  const evidence: EvidenceRef[] = input.scanned.map((f) => ({ kind: "page", id: f, strength: "certifier-observed", note: "scanned" }));
  if (input.findings.length === 0) return v("S5", "pass", `No PayPal secret or access token in ${input.scanned.length} public file(s).`, [], evidence);
  return v(
    "S5",
    "fail",
    "A PayPal secret is exposed to every visitor.",
    input.findings.map((f) => `${f.kind === "client_secret" ? "Client secret" : "Access token"} in ${f.file} (${f.masked}).`),
    [...input.findings.map((f) => ({ kind: "page" as const, id: f.file, strength: "certifier-observed" as const, note: `${f.kind} found: ${f.masked}` })), ...evidence],
  );
}

// S6 Sandbox and live mix-up: only sandbox hosts and IDs on a staging store.
export function judgeS6(input: { scanned: string[]; liveHostHits: { file: string; host: string }[]; sandboxOrderId?: string; sandboxOrderResolved?: boolean }): Verdict {
  if (input.scanned.length === 0) return v("S6", "inconclusive", "No public page or script could be scanned.", [], []);
  const evidence: EvidenceRef[] = input.scanned.map((f) => ({ kind: "page", id: f, strength: "certifier-observed", note: "scanned for live PayPal hosts" }));
  if (input.sandboxOrderId) {
    evidence.push({ kind: "order", id: input.sandboxOrderId, strength: "paypal-api", note: input.sandboxOrderResolved ? "exists in the PayPal sandbox" : "not found in the PayPal sandbox" });
  }
  const reasons = input.liveHostHits.map((h) => `Live PayPal host ${h.host} referenced in ${h.file}.`);
  if (input.sandboxOrderId && input.sandboxOrderResolved === false) reasons.push(`Order ${input.sandboxOrderId} created by the store does not exist in the PayPal sandbox.`);
  if (reasons.length > 0) return v("S6", "fail", "The staging store mixes sandbox and live PayPal.", reasons, evidence);
  if (input.sandboxOrderResolved === undefined) return v("S6", "pass", "No live PayPal hosts in public code (order check not available).", [], evidence);
  return v("S6", "pass", "Only sandbox PayPal is in use: no live hosts, and the store's orders exist in the sandbox.", [], evidence);
}

// S7 Retry safety: a retried order creation with the same PayPal-Request-Id yields one order.
export function judgeS7(input: { hookSupported: boolean; createAttempts?: string[]; resolved?: PaypalOrderSnap[] }): Verdict {
  if (!input.hookSupported) return v("S7", "inconclusive", "The store has no test hook to simulate a retried checkout.", [], []);
  const attempts = input.createAttempts ?? [];
  if (attempts.length < 2) return v("S7", "inconclusive", "The store did not report a retried order creation.", [], []);
  const distinct = [...new Set(attempts)];
  const real = (input.resolved ?? []).filter((o) => distinct.includes(o.id));
  const evidence: EvidenceRef[] = [
    { kind: "store_record", id: distinct.join(","), strength: "store-reported", note: `${attempts.length} create attempts reported` },
    ...real.map((o) => orderRef(o)),
  ];
  if (distinct.length === 1) return v("S7", "pass", "The retried checkout reused its PayPal-Request-Id: one order.", [], evidence);
  if (real.length >= 2) {
    return v("S7", "fail", "A retried checkout created duplicate PayPal orders.", [`PayPal holds ${real.length} separate orders (${real.map((o) => o.id).join(", ")}) for one checkout.`], evidence);
  }
  return v("S7", "inconclusive", "The store reported different order IDs, but PayPal could not confirm them.", [], evidence);
}

// S8 Checkout page hardening: Content-Security-Policy and HSTS present, PayPal allowed.
export function judgeS8(input: { url: string; status?: number; csp?: string; hsts?: string }): Verdict {
  if (input.status === undefined) return v("S8", "inconclusive", "The checkout page could not be fetched.", [], []);
  const evidence: EvidenceRef[] = [
    { kind: "page", id: input.url, strength: "certifier-observed", note: `CSP ${input.csp ? "present" : "missing"}, HSTS ${input.hsts ? "present" : "missing"}` },
  ];
  const reasons: string[] = [];
  if (!input.csp) reasons.push("No Content-Security-Policy header.");
  if (!input.hsts) reasons.push("No Strict-Transport-Security (HSTS) header.");
  if (input.csp && !/paypal\.com/i.test(input.csp)) reasons.push("The Content-Security-Policy does not allow PayPal domains (the PayPal button may be blocked).");
  return reasons.length === 0
    ? v("S8", "pass", "The checkout page sends CSP and HSTS headers that allow PayPal.", [], evidence)
    : v("S8", "fail", "The checkout page is missing security headers.", reasons, evidence);
}
