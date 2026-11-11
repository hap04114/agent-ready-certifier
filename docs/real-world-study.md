# Real-world study: certifying code we did not write

**Target:** PayPal's own public example integration,
[`paypal-examples/docs-examples`](https://github.com/paypal-examples/docs-examples), folder
`standard-integration` (HTML client + Node server), commit `809537903a2c` (2025-03-25).

**Date:** Nov 11, 2026. PayPal sandbox only. A throwaway sandbox app created for this study
(`REALWORLD_PAYPAL_*`), never the demo stores' apps.

## How it was hosted (and why)

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

## Results (run `cfbe640d`)

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

## What the study found in OUR certifier

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

## Limits

- One third-party integration, page-level only. The example's server was not run, so the purchase
  and webhook checks were not exercised on it.
- Local staging over `http://127.0.0.1`; S8 reflects the example as written plus default hosting.
- Reproduce: `pnpm realworld:serve <path>/standard-integration/client/html/src --port 3000`, then
  `pnpm certify:page http://127.0.0.1:3000`.
