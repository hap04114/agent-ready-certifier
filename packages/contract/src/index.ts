/**
 * The store contract: what a merchant adds so the certifier can test a store it did not build.
 *
 *  1. Ownership token   — public, served on the store (Milestone 4).
 *  2. Webhook copy      — the merchant adds the certifier's listener to their sandbox app and
 *                         shares that webhook's ID; the certifier verifies PayPal's signatures itself.
 *  3. Status endpoint   — GET  /.well-known/certifier/orders/{paypalOrderId}
 *  4. Test hook (opt.)  — POST /.well-known/certifier/test-hook  { paypalOrderId, mock }
 *                         arms a sandbox mock code for that order's next capture (W2/W3).
 *  5. Read-only sandbox credentials (optional) for deeper PayPal-side checks.
 *
 * Endpoints 3 and 4 require `Authorization: Bearer <status key>`. The status key is private,
 * derived per store by the certifier, and is NOT the public ownership token.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const CONTRACT_BASE = "/.well-known/certifier";
export const statusPath = (paypalOrderId: string) => `${CONTRACT_BASE}/orders/${encodeURIComponent(paypalOrderId)}`;
export const TEST_HOOK_PATH = `${CONTRACT_BASE}/test-hook`;

/** Mock codes the test hook may arm. Anything else is refused. */
export const TEST_HOOK_CODES = ["INSTRUMENT_DECLINED", "INTERNAL_SERVER_ERROR"] as const;
export type TestHookCode = (typeof TEST_HOOK_CODES)[number];

export const testHookRequest = z.object({
  paypalOrderId: z.string().regex(/^[A-Z0-9]{5,40}$/),
  mock: z.enum(TEST_HOOK_CODES),
});

const money = z.object({ currencyCode: z.string().length(3), value: z.string().regex(/^\d+(\.\d{1,2})?$/) });

/** What a store reports for one PayPal order. Everything here is "store-reported" evidence. */
export const storeOrderStatus = z.object({
  paypalOrderId: z.string(),
  status: z.string(),
  amount: money.optional(),
  captureIds: z.array(z.string()),
  refundIds: z.array(z.string()),
  fulfilmentCount: z.number().int().min(0),
  webhookEvents: z.array(
    z.object({ eventId: z.string(), type: z.string(), deliveries: z.number().int().min(0), processed: z.number().int().min(0) }),
  ),
  updatedAt: z.string().optional(),
});
export type StoreOrderStatus = z.infer<typeof storeOrderStatus>;

/** Canonical origin used in key derivation: scheme + host + port, lower-case, no path. */
export function storeOrigin(url: string): string {
  return new URL(url).origin.toLowerCase();
}

/** Private per-store status key: HMAC-SHA256(OWNERSHIP_TOKEN_SECRET, "status-key:v1:" + origin). */
export function deriveStatusKey(secret: string, storeUrl: string): string {
  if (secret.length < 32) throw new Error("OWNERSHIP_TOKEN_SECRET must be at least 32 characters");
  return createHmac("sha256", secret).update(`status-key:v1:${storeOrigin(storeUrl)}`).digest("base64url");
}

/** Constant-time check of an `Authorization: Bearer <key>` header. */
export function bearerMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!header || !expected) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
