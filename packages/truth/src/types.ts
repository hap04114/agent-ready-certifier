/**
 * Truth-checker types. Rules are pure functions over these snapshots: no network, no AI.
 * A missing snapshot (undefined) means the data was unavailable, which yields "inconclusive",
 * never a guessed pass.
 */

export type CheckCode = "W1" | "W2" | "W3" | "W4" | "W5" | "W6";
export type VerdictStatus = "pass" | "fail" | "inconclusive";

/**
 * How strong a piece of evidence is:
 * - paypal-signed: a webhook event whose PayPal signature we verified ourselves
 * - paypal-api:    a record read from PayPal's API with the merchant's sandbox credentials
 * - store-reported: what the store's status endpoint says it recorded
 */
export type EvidenceStrength = "paypal-signed" | "paypal-api" | "store-reported";
export type EvidenceKind = "order" | "capture" | "refund" | "webhook_event" | "webhook_delivery" | "store_record";

export interface EvidenceRef {
  kind: EvidenceKind;
  /** The PayPal ID (order, capture, refund, event) or the store's order reference. */
  id: string;
  strength: EvidenceStrength;
  note?: string;
}

export interface Verdict {
  check: CheckCode;
  status: VerdictStatus;
  /** One-line plain-language summary. */
  summary: string;
  reasons: string[];
  evidence: EvidenceRef[];
}

export interface MoneySnap {
  currencyCode: string;
  value: string;
}

/** Orders v2 record (paypal-api). */
export interface PaypalOrderSnap {
  id: string;
  status: string;
  amount?: MoneySnap;
  captures: { id: string; status: string; amount?: MoneySnap }[];
}

/** Payments v2 refund (paypal-api). */
export interface PaypalRefundSnap {
  id: string;
  status: string;
  amount?: MoneySnap;
}

/** What the store reports for one PayPal order (store-reported). */
export interface StoreRecordSnap {
  paypalOrderId: string;
  status: string;
  amount?: MoneySnap;
  captureIds: string[];
  refundIds: string[];
  /** Times the store fulfilled (shipped) this order. */
  fulfilmentCount: number;
  webhookEvents: { eventId: string; type: string; deliveries: number; processed: number }[];
}

/** A webhook event received by the certifier's own listener (paypal-signed when valid). */
export interface SignedEventSnap {
  eventId: string;
  type: string;
  resourceId?: string;
  signatureValid: boolean;
  receivedAt: string;
}

/** Delivery attempts PayPal reports for one event (paypal-api). */
export interface DeliverySnap {
  eventId: string;
  transmissions: { webhookUrl?: string; httpStatus?: number; status?: string }[];
}
