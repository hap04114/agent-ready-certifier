# Seeded bugs (demo-store-buggy)

`demo-store-buggy` runs **the same code** as `demo-store-good`, with exactly these ten bugs
switched on (`SEEDED_BUGS` in `apps/demo-stores/src/good/server.ts`). Each bug is meant to make
one certifier check fail. This list is the answer key for the accuracy benchmark
(`docs/benchmark.md`): a bug counts as *found* only when its check fails **with evidence**.

| # | Seeded bug | Where in the code | Check that must fail | Business impact if shipped |
| --- | --- | --- | --- | --- |
| 1 | Refund webhook handler broken | `PAYMENT.CAPTURE.REFUNDED` is acknowledged but never recorded | **W4** | Refund missed: the store still shows the order as paid after PayPal refunded it |
| 2 | Server trusts the client-sent price | `POST /api/orders` uses `price` from the browser | **S1** | Underpayment: a shopper can pay $1.00 for a $50.00 item |
| 3 | Accepts unsigned webhooks | signature verification skipped | **S2** | Unpaid order shipped: a forged "payment completed" event marks an order paid |
| 4 | No webhook deduplication | every delivery is processed, and each one "ships" again | **S3**, **W6** | Double fulfilment: one payment, two shipments |
| 5 | Client secret exposed in a JS bundle | `/checkout.js` contains the app's client secret | **S5** | Account takeover risk: anyone can call PayPal's API as the merchant |
| 6 | No PayPal-Request-Id reuse on retries | a retried order creation gets a new request ID | **S7** | Duplicate orders: one checkout, two PayPal orders |
| 7 | Missing CSP and HSTS | security headers not sent | **S8** | The checkout page is easier to tamper with (script injection, downgrade) |
| 8 | No Pay Later messaging | SDK loaded without `messages`, no placement | **C2** | Lost conversion: shoppers are not told they can pay over time |
| 9 | Stale machine-readable price | the page's Schema.org JSON-LD shows a 10%-off price checkout never charges | **A4** | Wrong quotes to agents and shopping surfaces; Google Merchant Center can disapprove products whose prices don't match |
| 10 | Unlabeled checkout controls | the product picker and quantity box lose their `<label>`s (they look the same) | **A5** | AI agents and screen-reader users can't tell what the controls do |

Bugs 9 and 10 were added on Nov 11, 2026 with the two store-level Agent-ready checks (A4, A5).

## Safety

- **Sandbox only.** Like everything in this project, the buggy store only talks to
  `api-m.sandbox.paypal.com`.
- **Its own throwaway sandbox app.** Bug 5 deliberately exposes a client secret, so the buggy
  store never uses the good store's app. The exposed secret belongs to a sandbox-only app created
  for this purpose; delete that app after the hackathon.
- The benchmark also counts **false alarms**: any check that fails on `demo-store-good` (which has
  none of these bugs) counts against the certifier.

## Checks that should pass on both stores

W1–W3, W5, S4 (order replay), S6 (sandbox/live mix-up), C1 (current SDK), C3 (button visible
early) and C5 (Venmo) are **not** seeded, so they should pass on the buggy store too. A failure
there would be a false alarm. C4 is "not applicable" on both stores.
