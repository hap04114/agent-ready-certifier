# Store contract

What a merchant adds so the certifier can test a PayPal checkout it did not build. Everything runs
in the PayPal **sandbox** only. The shared definitions live in `packages/contract`.

## Core contract (needed for a certificate)

| # | Item | What the merchant does | What it enables |
| --- | --- | --- | --- |
| 1 | Ownership token | Serves the token the certifier gives them (meta tag or file). Public by design. | Any testing at all (Milestone 4). |
| 2 | Webhook copy | Adds the certifier's listener URL as a webhook on their sandbox app and shares **that** webhook's ID. | PayPal-signed evidence of captures and refunds. The certifier verifies PayPal's signatures itself; no merchant secret is needed. |
| 3 | Status endpoint | `GET /.well-known/certifier/orders/{paypalOrderId}` with `Authorization: Bearer <status key>`. | What the store recorded (store-reported evidence). |
| 4 | Test hook (optional) | `POST /.well-known/certifier/test-hook` `{ paypalOrderId, mock }`, status key required, sandbox only. Arms `INSTRUMENT_DECLINED` or `INTERNAL_SERVER_ERROR` for the order's next capture. | W2 and W3. Without it they are "inconclusive", never a guessed pass. |
| 5 | Read-only sandbox credentials (optional) | Shares sandbox API credentials scoped to reading. | PayPal-API evidence (order, capture, refund records). |

The **status key** is private and per store: `HMAC-SHA256(OWNERSHIP_TOKEN_SECRET, "status-key:v1:" + store origin)`.
It is not the public ownership token.

## Extended contract (optional): full duplicate testing for W6

| # | Item | Rules |
| --- | --- | --- |
| 4b | Delivery log: `GET /.well-known/certifier/events/{eventId}/deliveries?since=<run start>` | Same status key as the status endpoint. Returns only deliveries received since the run started (`since` is required). The store keeps them for at most 24 hours. Sandbox only. Only deliveries whose PayPal signature the store verified are logged. |
| 4c | Store webhook ID | Shared as configuration so the certifier can verify PayPal's signature on the store's own copy of an event. It is never shown in reports. |

### How W6 uses it

1. The certifier asks PayPal to re-send the event (PayPal's resend API).
2. If the extended contract is available, the certifier fetches the store's own delivery, **verifies PayPal's signature
   on it with the store webhook ID**, and sends the identical bytes again.
   Evidence: *"duplicate of PayPal-signed event, replayed by certifier"*.
3. At the end of the run (no extra waiting), any delivery with a **new** transmission ID that verifies as PayPal-signed
   is labelled *"duplicate delivered by PayPal"*. A replay can only reuse the original transmission ID, so a replay is
   never labelled as a PayPal delivery.
4. W6 passes when every verified duplicate was processed exactly once and nothing was fulfilled or refunded twice.

Without the extended contract, W6 still runs on PayPal's resend alone. If no duplicate arrives, W6 is
"inconclusive" and the report states that the replay path was not available. It is never failed for that alone.

## Demo stores

Both demo stores implement the full extended contract. The good store also has a **demo-only** fail-ack hook
(`POST /__demo/fail-ack`, not part of the contract): it processes one chosen event, then answers with an error once,
so PayPal retries a delivery the store has already handled.
