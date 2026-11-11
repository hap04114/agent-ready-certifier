/**
 * Truth-checker types. Rules are pure functions over these snapshots: no network, no AI.
 * A missing snapshot (undefined) means the data was unavailable, which yields "inconclusive",
 * never a guessed pass.
 */

export type CheckCode =
  | "W1" | "W2" | "W3" | "W4" | "W5" | "W6"
  | "C1" | "C2" | "C3" | "C4" | "C5"
  | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8"
  | "R1" | "A1" | "A2" | "A3" | "A4" | "A5"
  | "R2" | "A6" | "R3";
export type VerdictStatus = "pass" | "fail" | "inconclusive";

/**
 * How strong a piece of evidence is:
 * - paypal-signed: a webhook event whose PayPal signature we verified ourselves
 * - paypal-api:    a record read from PayPal's API with the merchant's sandbox credentials
 * - store-reported: what the store's status endpoint says it recorded
 * - certifier-observed: what the certifier saw directly on the public site (page source,
 *   scripts, response headers, button position)
 * - owner-passkey: the store owner's passkey (WebAuthn) signature over one exact approval request,
 *   re-checked by the certifier against the registered public key
 * - certifier-recorded: the certifier's own recording (e.g. a Kernel browser video); shows what
 *   happened, never decides a verdict
 */
export type EvidenceStrength = "paypal-signed" | "paypal-api" | "owner-passkey" | "store-reported" | "certifier-observed" | "certifier-recorded";
export type EvidenceKind = "order" | "capture" | "refund" | "webhook_event" | "webhook_delivery" | "store_record" | "video" | "page" | "trial" | "approval";

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
