# Real-world study: certifying code we did not write

**Target:** PayPal's own public example integration,
[`paypal-examples/docs-examples`](https://github.com/paypal-examples/docs-examples), folder
`standard-integration` (HTML client + Node server), commit `809537903a2c` (2025-03-25).

PayPal sandbox only. A throwaway sandbox app created for this study (`REALWORLD_PAYPAL_*`), never
the demo stores' apps.

## Full certification (Nov 12, run `c38fb9cd`)

**Report:** [certifier-api.onrender.com/run?id=c38fb9cd-…](https://certifier-api.onrender.com/run?id=c38fb9cd-21c4-4e21-9d62-29b9a6d3dae1)

### How it was hosted

- The example's server and page run **unchanged** (byte for byte, see
  [`thirdparty/paypal-standard-integration`](../thirdparty/paypal-standard-integration)) as their own
  Render service, `paypal-example-store`, separate from the certifier and the demo stores.
- In front of it sits a **thin adapter we wrote** (`adapter.mjs`, zero dependencies). It does what the
  example's own Vite dev setup does (fill in `%PAYPAL_CLIENT_ID%`, forward `/api/*`), plus the store
  contract: the ownership meta tag, and a status endpoint that reports **only what the example's own
  create and capture responses said**. It changes no request or response, never calls PayPal, and adds no
  security headers, webhook handler or test hook. The example has none, so their absence shows in the report.
- The example's server gets only its own variables (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` of the
  throwaway app), never the certifier's status key.
- The certifier's webhook listener was added to the throwaway app (store contract item 2), so PayPal's
  signed capture and refund events are evidence even though the example has no listener of its own.

### How it was tested

The example captures **in the browser**: its page calls its own `/api/orders/:id/capture` after the buyer
approves. So the purchase was made the way a real buyer makes it: an **AI buyer in a recorded Kernel cloud
browser clicked the example's own PayPal button**, logged in to the sandbox buyer account and paid
(9 steps, Kernel replay `p4pmsm0d0rs65mg9suyjzs5y`). Everything else ran as for every store (`pnpm
thirdparty:run`), judged by the same plain-code rules. 43 requests in total.

### Results: 9 pass, 3 fail, 9 inconclusive

| Check | Result | Evidence and notes |
| --- | --- | --- |
| W1 purchase | **pass** | PayPal order `1BH03120C2779054C` COMPLETED, capture `64G9970430253901E` 100.00 USD; the example's capture response agrees |
| W2 decline, W3 server error | inconclusive | the example has no test hook, so a decline or PayPal error cannot be forced; never guessed |
| W4 refund | **fail** | refund `2GF07565H0192415T` COMPLETED and PayPal's signed refund event `WH-6RV338327S2067607-00J65391G00376806` verified, but the example still shows the order as paid: it has no webhook handler, so it never learns of refunds |
| W5 webhook delivery | inconclusive | PayPal's signed capture event `WH-0AC54367SM891310C-07P766763S868305S` reached and verified at the certifier; the example has no webhook endpoint, so there is no store delivery to confirm |
| W6 duplicate, S3 replay | inconclusive | no webhook endpoint or delivery log to send a verified duplicate to |
| C1 SDK, C2 Pay Later, C3 above the fold, C5 Venmo | **pass** | same as the page-level study below |
| C4 saved methods | inconclusive | not configured (not applicable) |
| S1 price tampering | **pass** | every price field, top level and in the cart item, set to 1.00: PayPal order `9T654596FL6412537` is still 100.00 USD. The example ignores the cart entirely and charges a fixed 100.00 (see note) |
| S2 forged webhook | **pass** | an unsigned "payment completed" for order `2XR0527663689871C` changed nothing (the example has no webhook route at all, HTTP 404) |
| S4 order replay | **fail** | asked to capture order `1BH03120C2779054C` again, the example answered **HTTP 201, status COMPLETED** (PayPal's answer, passed through, carrying the original capture). PayPal kept **one** capture: no double charge. But the example's page shows that answer as "Transaction COMPLETED" again, so a shop that fulfils on it (the example's comments suggest redirecting to a thank-you page) would fulfil the order twice. The adapter counts each successful capture response shown to the buyer as one fulfilment (1 → 2) |
| S5 secrets, S6 sandbox only | **pass** | no secret in the 2 public files; only sandbox hosts; the order exists in the sandbox |
| S7 retry safety | inconclusive | no test hook to simulate a retried checkout |
| S8 security headers | **fail** | no Content-Security-Policy, no HSTS |
| A4 machine-readable price, A5 accessible names | inconclusive | no Schema.org price published; the only controls are PayPal's own buttons (in PayPal's iframes, excluded) |

### What it means

The three failures are the gaps a merchant **inherits** by shipping the example as is. They are not bugs
in a sample that never claimed to be a full shop: record refunds (a webhook handler for
`PAYMENT.CAPTURE.REFUNDED`), refuse or de-duplicate a second capture before confirming success, and send
CSP and HSTS headers. The nine inconclusive checks are honest: they need a test hook or a webhook endpoint
that the example does not have, and the certifier never guesses a pass.

**Note on S1:** the example's server creates every order for a hard-coded `100.00 USD` and ignores the cart
(its own comment says to compute the amount from the cart). That makes price tampering impossible, but a real
shop built on it unchanged would charge every buyer 100.00. S1 compares with that fixed price, since the
example has no catalog.

**Limits:** one run (N = 1); one example (Node server, HTML page); the adapter is ours, and its status
endpoint can only report what the example's responses said.

**Reproduce:** `pnpm store:keys`, `pnpm webhooks:ensure <listener URL> EXAMPLE_STORE_CERTIFIER_WEBHOOK_ID`,
deploy the `paypal-example-store` service from `render.yaml`, `pnpm render:sync`, then `pnpm thirdparty:run`.

---

## Earlier: page-level study (Nov 11, run `cfbe640d`)

### How it was hosted (and why)

The certifier only tests stores whose owner proves ownership, so we hosted the example on **our
own local staging** (`http://127.0.0.1:3000`, `pnpm realworld:serve`):

- Its two front-end files (`index.html`, `app.js`) were served **unchanged** except for (1) the
  public sandbox client ID in place of the documented `%PAYPAL_CLIENT_ID%` placeholder and (2) our
  ownership meta tag.
- **Its server was not run, and nothing of it was installed** (no `npm install`): running outside
  code on the developer's machine with credentials was deliberately not allowed in this project
  without explicit sign-off. Only the public client ID was used, never a secret.
- So this is a **page-level certification** (`pnpm certify:page`): C1–C5, S5, S6, S8, A4, A5, by the
  same plain-code rules as a full run, with browser measurements in a local Edge. Checks that need
  real purchases or the store contract (W1–W6, S1–S4, S7) were **not run**, and are not guessed.

### Results (run `cfbe640d`)

| Check | Result | Notes |
| --- | --- | --- |
| C1 current SDK | **pass** | PayPal JavaScript SDK (`/sdk/js`, components=buttons) |
| C2 Pay Later | **pass** | button-integrated message (`Buttons({ message: { amount: 100 } })`), rendered as "Pay in full or 4 interest-free payments of $25.00" |
| C3 button above the fold | **pass** | measured in local Edge at 1280×800 |
| C4 saved methods | not applicable | not configured |
| C5 Venmo | **pass** | `enable-funding=venmo`, Venmo button rendered |
| S5 exposed secrets | **pass** | no secret or token in the 2 public files |
| S6 sandbox/live | **pass** | no live PayPal hosts in public code |
| S8 security headers | **fail** | no CSP, no HSTS. The example's server (`server.js`, Express) configures none, and its Vite front end sends none by default; a production host could add them, so this is a finding about the example as written |
| A4 machine-readable price | inconclusive | the page publishes no Schema.org price (reported, not failed) |
| A5 accessible names | inconclusive | the page's only controls are PayPal's own buttons (in PayPal's iframes, which we exclude) |

**Also visible from reading the code (not a certifier verdict):** `server.js` creates every order for a
hard-coded `100.00 USD` and ignores the cart (its own comment says to compute the amount from the
cart). That is safe against price tampering, but a real shop built on it unchanged would charge the
wrong amount. A full certification (W1, S1) would show it once the example implements the store
contract.

### What the study found in OUR certifier

The first run (`084413f7`) **failed C2: a false alarm.** Our rule only knew the older Pay Later
*messages component*. PayPal's own example uses the newer **button-integrated message**, rendered
inside the buttons iframe. Fixed in both places:

- the browser measurement now looks for message text ("Pay in 4", "interest-free payments") inside
  PayPal's buttons iframe, but **not** the words "Pay Later" alone, which is also the label of the
  Pay Later *funding button* and is not a message;
- the page scan recognises `Buttons({ message: { amount | align | color | position | offer } })`.

Controls after the fix, same day:

| Store | Run | C2 | Overall (page-only) |
| --- | --- | --- | --- |
| PayPal example | `cfbe640d` | pass | 6 pass, 1 fail (S8), 3 inconclusive |
| our buggy store | `fdc68421` | **fail** (correct: seeded `no_pay_later`) | 4 pass, 4 fail (C2, S5, S8, A5: all seeded), 2 inconclusive |
| our good store | `77d7a79f` | pass | 8 pass, **0 fail**, 2 inconclusive |

### Limits

- One third-party integration, page-level only. The example's server was not run, so the purchase
  and webhook checks were not exercised on it.
- Local staging over `http://127.0.0.1`; S8 reflects the example as written plus default hosting.
- Reproduce: `pnpm realworld:serve <path>/standard-integration/client/html/src --port 3000`, then
  `pnpm certify:page http://127.0.0.1:3000`.
