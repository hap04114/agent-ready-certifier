/**
 * Works pillar rules W1–W6. Pure functions: same input, same verdict. No network, no AI.
 * Each rule returns "inconclusive" when the data it needs is unavailable.
 */
import { fmt, sameMoney } from "./money.js";
import type {
  CheckCode,
  DeliverySnap,
  EvidenceRef,
  PaypalOrderSnap,
  PaypalRefundSnap,
  SignedEventSnap,
  StoreRecordSnap,
  Verdict,
  VerdictStatus,
} from "./types.js";

const verdict = (check: CheckCode, status: VerdictStatus, summary: string, reasons: string[], evidence: EvidenceRef[]): Verdict => ({
  check,
  status,
  summary,
  reasons,
  evidence,
});

const orderRef = (o: PaypalOrderSnap): EvidenceRef => ({ kind: "order", id: o.id, strength: "paypal-api", note: `status ${o.status}` });
const captureRefs = (o: PaypalOrderSnap): EvidenceRef[] =>
  o.captures.map((c) => ({ kind: "capture", id: c.id, strength: "paypal-api", note: `status ${c.status}, ${fmt(c.amount)}` }));
const storeRef = (s: StoreRecordSnap): EvidenceRef => ({ kind: "store_record", id: s.paypalOrderId, strength: "store-reported", note: `status ${s.status}` });
const eventRef = (e: SignedEventSnap): EvidenceRef => ({
  kind: "webhook_event",
  id: e.eventId,
  strength: e.signatureValid ? "paypal-signed" : "store-reported",
  note: `${e.type}${e.signatureValid ? ", signature verified" : ", signature NOT verified"}`,
});

const completed = (o: PaypalOrderSnap) => o.captures.filter((c) => c.status === "COMPLETED");
/** PayPal statuses meaning the buyer never approved: the test journey failed, not the store. */
const NOT_APPROVED = new Set(["CREATED", "PAYER_ACTION_REQUIRED", "SAVED", "VOIDED"]);
const notApproved = (o: PaypalOrderSnap) => NOT_APPROVED.has(o.status) && o.captures.length === 0;
const is2xx = (n: number | undefined) => n !== undefined && n >= 200 && n < 300;

// ---------------------------------------------------------------------------------------------
// W1 Happy path: order COMPLETED, exactly one capture COMPLETED, store shows paid, amounts match.
// ---------------------------------------------------------------------------------------------
export function judgeW1(input: { order?: PaypalOrderSnap; store?: StoreRecordSnap }): Verdict {
  const { order, store } = input;
  if (!order) return verdict("W1", "inconclusive", "PayPal order record unavailable.", ["Could not read the order from PayPal."], []);
  const evidence = [orderRef(order), ...captureRefs(order)];
  if (notApproved(order)) {
    return verdict("W1", "inconclusive", "The test buyer never approved the order, so the purchase was not exercised.", [`PayPal order status is ${order.status}.`], evidence);
  }
  if (!store) return verdict("W1", "inconclusive", "Store record unavailable.", ["The store status endpoint did not return this order."], evidence);
  evidence.push(storeRef(store));

  const reasons: string[] = [];
  const caps = completed(order);
  if (order.status !== "COMPLETED") reasons.push(`PayPal order status is ${order.status}, expected COMPLETED.`);
  if (caps.length === 0) reasons.push("PayPal shows no COMPLETED capture.");
  if (caps.length > 1) reasons.push(`PayPal shows ${caps.length} COMPLETED captures for one order (duplicate capture).`);
  if (store.status !== "paid") reasons.push(`Store shows "${store.status}", expected "paid".`);
  const cap = caps[0];
  if (cap && !sameMoney(order.amount, cap.amount)) reasons.push(`Order amount ${fmt(order.amount)} differs from captured ${fmt(cap.amount)}.`);
  if (cap && !sameMoney(cap.amount, store.amount)) reasons.push(`Store amount ${fmt(store.amount)} differs from captured ${fmt(cap.amount)}.`);
  if (cap && !store.captureIds.includes(cap.id)) reasons.push(`Store does not list capture ${cap.id}.`);

  return reasons.length === 0
    ? verdict("W1", "pass", `Paid ${fmt(cap?.amount)}; PayPal and store agree.`, [], evidence)
    : verdict("W1", "fail", "PayPal and the store disagree about the purchase.", reasons, evidence);
}

// ---------------------------------------------------------------------------------------------
// W2 Decline / W3 Server error: the store's own capture call received a forced error.
// Pass: no COMPLETED capture in PayPal and the store does not show paid.
// ---------------------------------------------------------------------------------------------
interface ForcedErrorInput {
  /** Did the store accept the certifier's test hook (store-reported)? */
  hookSupported: boolean;
  order?: PaypalOrderSnap;
  store?: StoreRecordSnap;
  /** HTTP status the store returned to the certifier for the capture request. */
  storeCaptureHttpStatus?: number;
}

function judgeForcedError(check: "W2" | "W3", label: string, input: ForcedErrorInput): Verdict {
  if (!input.hookSupported) {
    return verdict(check, "inconclusive", `Store has no test hook, so a ${label} could not be simulated.`, [
      "The store did not accept the sandbox-only mock-response hook from the store contract.",
    ], []);
  }
  const { order, store } = input;
  if (!order) return verdict(check, "inconclusive", "PayPal order record unavailable.", [], []);
  const evidence = [orderRef(order), ...captureRefs(order)];
  if (notApproved(order)) {
    return verdict(check, "inconclusive", `The test buyer never approved the order, so the ${label} was not exercised.`, [`PayPal order status is ${order.status}.`], evidence);
  }
  if (!store) return verdict(check, "inconclusive", "Store record unavailable.", [], evidence);
  evidence.push(storeRef(store));

  const caps = completed(order);
  if (caps.length === 1 && store.status === "paid") {
    // A real capture happened: the forced error was never applied, so the scenario did not run.
    return verdict(check, "inconclusive", `The ${label} was not simulated: PayPal shows a real completed capture.`, [
      "The store accepted the hook but did not forward the mock code to PayPal.",
    ], evidence);
  }
  const reasons: string[] = [];
  if (caps.length > 1) reasons.push(`PayPal shows ${caps.length} COMPLETED captures (duplicate capture).`);
  if (caps.length === 0 && store.status === "paid") reasons.push(`Store shows "paid" although PayPal has no completed capture.`);
  if (is2xx(input.storeCaptureHttpStatus) && caps.length === 0) reasons.push(`Store told the buyer the capture succeeded (HTTP ${input.storeCaptureHttpStatus}).`);

  return reasons.length === 0
    ? verdict(check, "pass", `Store handled the ${label} correctly: nothing captured, not marked paid.`, [], evidence)
    : verdict(check, "fail", `Store mishandled the ${label}.`, reasons, evidence);
}

export const judgeW2 = (input: ForcedErrorInput) => judgeForcedError("W2", "decline (INSTRUMENT_DECLINED)", input);
export const judgeW3 = (input: ForcedErrorInput) => judgeForcedError("W3", "server error (INTERNAL_SERVER_ERROR)", input);

// ---------------------------------------------------------------------------------------------
// W4 Refund: refund COMPLETED in PayPal and the store shows refunded after the webhook.
// ---------------------------------------------------------------------------------------------
export function judgeW4(input: { refund?: PaypalRefundSnap; refundEvent?: SignedEventSnap; store?: StoreRecordSnap; refundError?: string }): Verdict {
  const { refund, refundEvent, store } = input;
  if (!refund) return verdict("W4", "inconclusive", "PayPal refund record unavailable.", input.refundError ? [input.refundError] : [], []);
  const evidence: EvidenceRef[] = [{ kind: "refund", id: refund.id, strength: "paypal-api", note: `status ${refund.status}, ${fmt(refund.amount)}` }];
  if (refund.status !== "COMPLETED") {
    return verdict("W4", "inconclusive", `PayPal refund is ${refund.status}, not COMPLETED yet.`, [], evidence);
  }
  if (refundEvent) evidence.push(eventRef(refundEvent));
  if (!store) return verdict("W4", "inconclusive", "Store record unavailable.", [], evidence);
  evidence.push(storeRef(store));

  const storeRefunded = store.status === "refunded" && store.refundIds.includes(refund.id);
  if (storeRefunded) return verdict("W4", "pass", "Refund completed in PayPal and recorded by the store.", [], evidence);

  if (!refundEvent?.signatureValid) {
    // Without a verified refund event we cannot tell a slow PayPal from a broken store.
    return verdict("W4", "inconclusive", "Refund webhook missing: no verified refund event reached the certifier.", [
      `Store shows "${store.status}". PayPal's refund event was not observed, so the store is not blamed.`,
    ], evidence);
  }
  return verdict("W4", "fail", "PayPal sent a signed refund event but the store did not record the refund.", [
    `Store shows "${store.status}"${store.refundIds.length ? ` with refunds ${store.refundIds.join(", ")}` : " with no refund"}; expected "refunded" with ${refund.id}.`,
  ], evidence);
}

// ---------------------------------------------------------------------------------------------
// W5 Webhook delivery: a real signed event for the capture verifies, and the store replied 2xx.
// ---------------------------------------------------------------------------------------------
export function judgeW5(input: {
  captureEvent?: SignedEventSnap;
  delivery?: DeliverySnap;
  /** The certifier's own listener URL, excluded when looking for the store's transmissions. */
  certifierWebhookUrl?: string;
  store?: StoreRecordSnap;
}): Verdict {
  const { captureEvent, delivery, store } = input;
  if (!captureEvent) {
    return verdict("W5", "inconclusive", "Capture webhook missing: no event reached the certifier.", [], []);
  }
  const evidence = [eventRef(captureEvent)];
  if (!captureEvent.signatureValid) {
    return verdict("W5", "inconclusive", "An event arrived but its PayPal signature did not verify, so it cannot be trusted.", [], evidence);
  }

  // Preferred: PayPal's own record of delivery to the store (paypal-api).
  const storeTx = (delivery?.transmissions ?? []).filter((t) => !input.certifierWebhookUrl || t.webhookUrl !== input.certifierWebhookUrl);
  if (delivery && storeTx.length > 0) {
    evidence.push({ kind: "webhook_delivery", id: delivery.eventId, strength: "paypal-api", note: storeTx.map((t) => `${t.httpStatus ?? "?"} ${t.status ?? ""}`.trim()).join("; ") });
    if (storeTx.some((t) => is2xx(t.httpStatus))) {
      return verdict("W5", "pass", "Signed capture event verified; PayPal reports the store answered 2xx.", [], evidence);
    }
    if (storeTx.every((t) => t.httpStatus !== undefined)) {
      return verdict("W5", "fail", "PayPal delivered the event but the store never answered 2xx.", [
        `Store responses: ${storeTx.map((t) => t.httpStatus).join(", ")}.`,
      ], evidence);
    }
  }

  // Fallback: the store's own report (weaker).
  const reported = store?.webhookEvents.find((e) => e.eventId === captureEvent.eventId);
  if (store) evidence.push(storeRef(store));
  if (reported && reported.deliveries > 0) {
    return verdict("W5", "pass", "Signed capture event verified; store reports receiving it (PayPal delivery status unavailable).", [], evidence);
  }
  return verdict("W5", "inconclusive", "Could not confirm the store received the event.", [
    "PayPal reported no delivery to the store yet and the store does not list the event.",
  ], evidence);
}

// ---------------------------------------------------------------------------------------------
// W6 Duplicate delivery: a duplicate of a genuine PayPal-signed event, delivered to the store,
// is processed exactly once.
//
// Two kinds of duplicate, never confused:
// - "certifier-replay": the certifier re-sent the store's own PayPal-signed delivery, byte for
//   byte, after verifying PayPal's signature on it for the store's webhook ID.
// - "paypal": the store received a delivery with a NEW transmission ID whose PayPal signature the
//   certifier verified. A replay can only reuse the original transmission ID, so a new, validly
//   signed transmission can only have come from PayPal (a retry or a resend).
// ---------------------------------------------------------------------------------------------
export interface DuplicateDelivery {
  eventId: string;
  source: "certifier-replay" | "paypal";
  /** The certifier verified PayPal's signature on these exact bytes for the store's webhook ID. */
  signatureVerified: boolean;
  transmissionId?: string;
}

const duplicateNote = (d: DuplicateDelivery) =>
  d.source === "paypal"
    ? `duplicate delivered by PayPal${d.transmissionId ? ` (transmission ${d.transmissionId})` : ""}`
    : "duplicate of PayPal-signed event, replayed by certifier";

export function judgeW6(input: {
  duplicates: DuplicateDelivery[];
  /** Store record for the order before the first duplicate, and at judging time. */
  before?: StoreRecordSnap;
  after?: StoreRecordSnap;
  /** Why a duplicate could not be produced (e.g. PayPal refused the resend, replay failed). */
  notes?: string[];
}): Verdict {
  const { before, after } = input;
  const verified = input.duplicates.filter((d) => d.signatureVerified);
  if (verified.length === 0) {
    return verdict("W6", "inconclusive", "No verified duplicate of a PayPal-signed event reached the store.", input.notes ?? [], []);
  }
  if (!before || !after) return verdict("W6", "inconclusive", "Store record unavailable.", input.notes ?? [], []);

  const evidence: EvidenceRef[] = verified.map((d) => ({ kind: "webhook_delivery", id: d.eventId, strength: "paypal-signed", note: duplicateNote(d) }));
  evidence.push(storeRef(after));

  const reasons: string[] = [];
  for (const eventId of new Set(verified.map((d) => d.eventId))) {
    const rec = after.webhookEvents.find((e) => e.eventId === eventId);
    if (!rec) reasons.push(`Store does not list event ${eventId}.`);
    else if (rec.processed !== 1) reasons.push(`Store processed event ${eventId} ${rec.processed} times.`);
  }
  if (after.fulfilmentCount !== before.fulfilmentCount) {
    reasons.push(`Fulfilments changed from ${before.fulfilmentCount} to ${after.fulfilmentCount} after a duplicate event.`);
  }
  if (after.refundIds.length > 1) reasons.push(`Store recorded ${after.refundIds.length} refunds for one refund.`);

  const byPaypal = verified.some((d) => d.source === "paypal");
  return reasons.length === 0
    ? verdict(
        "W6",
        "pass",
        byPaypal
          ? "A duplicate delivered by PayPal was processed exactly once."
          : "A duplicate of a PayPal-signed event (replayed by the certifier) was processed exactly once.",
        [],
        evidence,
      )
    : verdict("W6", "fail", "Store re-processed a duplicate webhook event.", reasons, evidence);
}
