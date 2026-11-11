/**
 * R3 agent checkout funnel: how far an AI shopper got buying on the REAL store, decided from
 * evidence (what PayPal records, what the store records), never from the agent's own "done".
 */
import type { EvidenceRef, PaypalOrderSnap, StoreRecordSnap, Verdict } from "./types.js";

export type FunnelStage = "store" | "paypal_opened" | "approved" | "paid";
export const FUNNEL_STAGES: FunnelStage[] = ["store", "paypal_opened", "approved", "paid"];

export interface FunnelInput {
  /** The journey loaded the store at all (certifier-observed). */
  reachedStore: boolean;
  /** The PayPal order the agent opened, as read back from PayPal (paypal-api). */
  order?: PaypalOrderSnap;
  /** The store's record of that order (store-reported). */
  store?: StoreRecordSnap;
  /** Why the journey ended, in the agent's own words (reported, never decisive). */
  agentOutcome: string;
}

export function funnelStage(i: FunnelInput): FunnelStage | "none" {
  if (!i.reachedStore) return "none";
  if (!i.order) return "store";
  const captured = i.order.captures.some((c) => c.status === "COMPLETED");
  if (captured && i.store?.status === "paid") return "paid";
  if (captured || i.order.status === "APPROVED" || i.order.status === "COMPLETED") return "approved";
  return "paypal_opened";
}

export function judgeR3(i: FunnelInput): Verdict {
  const stage = funnelStage(i);
  const evidence: EvidenceRef[] = [];
  if (i.order) evidence.push({ kind: "order", id: i.order.id, strength: "paypal-api", note: `status ${i.order.status}; captures ${i.order.captures.map((c) => c.status).join(",") || "none"}` });
  if (i.store) evidence.push({ kind: "store_record", id: i.store.paypalOrderId, strength: "store-reported", note: `status ${i.store.status}` });
  const reasons = stage === "paid" ? [] : [`Furthest stage: ${stage}. The journey ended with "${i.agentOutcome}" (the agent's own report).`];
  return stage === "paid"
    ? { check: "R3", status: "pass", summary: "The AI shopper completed a purchase on the store: PayPal captured it and the store shows it paid.", reasons, evidence }
    : { check: "R3", status: "fail", summary: `The AI shopper did not finish buying (stopped at: ${stage}).`, reasons, evidence };
}
