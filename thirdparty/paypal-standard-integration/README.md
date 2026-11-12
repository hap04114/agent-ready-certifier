# PayPal's example integration, run as a store we did not write

**What this is:** PayPal's own public example,
[`paypal-examples/docs-examples`](https://github.com/paypal-examples/docs-examples), folder
`standard-integration` (HTML client + Node server), commit `809537903a2c38757d33cd871465741c610088cd`,
deployed as its own Render service (`paypal-example-store`) so the certifier can run a **full**
certification (real purchases, refunds, attacks) on code we did not write.

`example/` holds the example's files **byte for byte** (Apache-2.0, see `example/LICENSE`):

| File here | Original path |
| --- | --- |
| `example/server/server.js`, `example/server/package.json` | `standard-integration/server/node/` |
| `example/client/index.html`, `example/client/app.js` | `standard-integration/client/html/src/` |

## The thin adapter (`adapter.mjs`, ours, zero dependencies)

It does what the example's own Vite dev setup does, plus the [store contract](../../docs/store-contract.md):

- serves the example's page with Vite's `%PAYPAL_CLIENT_ID%` substitution, plus the certifier's
  public ownership meta tag (and `/.well-known/certifier/ownership.txt`);
- forwards `/api/*` to the example's server unchanged, as Vite's dev proxy does;
- records what the example's own create and capture responses said, and reports it at the status
  endpoint `GET /.well-known/certifier/orders/{id}` (Bearer status key).

It never changes a request or response and never calls PayPal. It adds **no** security headers,
webhook handler or test hook, because the example has none: those gaps show up in the report as
they would for any merchant who shipped the example as is.

The example's server gets only `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (a throwaway sandbox app,
`REALWORLD_PAYPAL_*`), `PORT` and `PATH`; never the certifier's status key.

## Deploy and run

1. `pnpm store:keys` derives `EXAMPLE_STORE_STATUS_KEY` and `EXAMPLE_STORE_OWNERSHIP_TOKEN` for
   `EXAMPLE_STORE_URL` in `.env`.
2. `pnpm webhooks:ensure <certifier listener URL> EXAMPLE_STORE_CERTIFIER_WEBHOOK_ID` adds the
   certifier's listener as a webhook on the throwaway app (store contract item 2).
3. Render creates the `paypal-example-store` service from `render.yaml`; `pnpm render:sync` sets its
   four variables.
4. `pnpm thirdparty:run` runs the full certification (AI buyer in a Kernel cloud browser, real
   sandbox payments, the same plain-code rules as every other store).

Results: [docs/real-world-study.md](../../docs/real-world-study.md).
