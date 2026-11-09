# Agent-Ready Certifier

[![CI](https://github.com/hap04114/agent-ready-certifier/actions/workflows/ci.yml/badge.svg)](https://github.com/hap04114/agent-ready-certifier/actions/workflows/ci.yml)

Tests a merchant's own PayPal checkout the way a real shopper, an attacker and an AI shopping
agent would, then proves every result from PayPal's own **sandbox** records.
See [docs/project-brief.md](docs/project-brief.md) and [docs/technical-design.md](docs/technical-design.md).

> **Sandbox only.** Every service refuses to start unless `PAYPAL_ENV=sandbox` and
> `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`. No real money is ever involved.

## Status

Work in progress for the PayPal AI Hackathon. Currently at **Milestone 1 (Foundation)**.

| Feature | State |
| --- | --- |
| Sandbox-enforced config loader | Built and tested |
| PayPal client wrapper (Orders v2 via PayPal Server SDK, request IDs, audit log) | Built; unit-tested against a fake. Not yet run against sandbox |
| demo-store-good (create and capture, store status endpoint, CSP and HSTS, pay-later messaging) | Built; unit-tested against a fake. Not yet run against sandbox |
| Product catalog | **Placeholder** hand-written products until Channel3 is connected |
| Store records | In memory; lost when the store process restarts |
| Webhooks, truth checker, browser agent, probes, AI shopper, diagnosis, certificates | Not built yet |

## Setup

Requires Node.js 22+ and pnpm 9.

```bash
pnpm install
cp .env.example .env      # then fill in .env (never commit it)
pnpm check:env            # validates config; shows secrets only as "set" / "not set"
pnpm test                 # unit tests (no network, no credentials needed)
pnpm typecheck
```

### Run the good demo store (needs sandbox credentials)

```bash
pnpm dev:store-good       # http://localhost:5001
```

Open the page, click the PayPal button, log in with your **sandbox personal (buyer)** account
and approve. Then check that PayPal and the store agree:

```bash
pnpm verify:order <PAYPAL_ORDER_ID>
```

### Run the API

```bash
pnpm dev:api              # http://localhost:4000/health
```

## Environment variables and when they are needed

| Variables | Needed from |
| --- | --- |
| `PAYPAL_ENV`, `PAYPAL_API_BASE` | Always (boot fails otherwise) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Milestone 1: demo store and `verify:order` |
| `PAYPAL_SANDBOX_BUYER_EMAIL`, `PAYPAL_SANDBOX_BUYER_PASSWORD` | Milestone 1 when you approve by hand; read by code from Milestone 3 (browser agent) |
| `PAYPAL_WEBHOOK_ID`, `WEBHOOK_PUBLIC_URL` | Milestone 2 (webhook listener, needs public HTTPS) |
| `DATABASE_URL` | Milestone 2 (evidence storage) |
| `KERNEL_API_KEY`, `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` | Milestone 3 (browser agent) |
| `QUEUE_URL`, `OWNERSHIP_TOKEN_SECRET` | Milestone 4 (worker, ownership verifier) |
| `CHANNEL3_API_KEY` | Milestone 5–6 (real products, lookalike traps) |
| `PAYPAL_LOOKALIKE_CLIENT_ID`, `PAYPAL_LOOKALIKE_CLIENT_SECRET` | Milestone 6 (A3 trap) |
| `APIMATIC_CONTEXT_MCP_URL` | Milestone 7 (diagnosis agent) |
| `CERT_SIGNING_PRIVATE_KEY`, `WEBAUTHN_*`, `TESTNET_*` | Milestone 8 (trust layer) |

`PORT` is set by Render in hosting; locally the API uses the port in `API_BASE_URL` and the good store uses 5001.

## Security of this repository

- **No secrets in git.** `.env` is gitignored; only `.env.example` (no values) is committed.
- **Secret scanning, three layers:**
  - `pnpm scan:secrets` runs [gitleaks](https://github.com/gitleaks/gitleaks) over the full history and staged changes,
    then `scan:env-values`, which fails if any actual value from your local `.env` appears in a tracked file
    (pattern scanners miss secrets without a known format). Output names variables, never values.
  - A `pre-push` hook (`.githooks/pre-push`, enabled with `git config core.hooksPath .githooks`) runs the same scans.
  - CI runs gitleaks over the full history on every push and fails the build on any finding.
- **CI needs no secrets.** Unit tests never call PayPal; workflow permissions are read-only.
- **Dependabot** alerts and weekly update PRs for npm packages and GitHub Actions.

## Optional: enable full duplicate testing in 2 steps

W6 checks that a store processes a duplicate PayPal webhook exactly once. It always tries PayPal's resend API.
To also let the certifier replay a genuine PayPal-signed delivery (and get a definite result), a store adds the
extended contract ([docs/store-contract.md](docs/store-contract.md)):

1. **Expose the delivery log:** `GET /.well-known/certifier/events/{eventId}/deliveries?since=<run start>`, protected
   by the same status key as the status endpoint, sandbox only, returning only deliveries from the current run and
   keeping them no longer than 24 hours.
2. **Share your store's webhook ID** with the certifier as configuration (it is never shown in reports).

Without these, W6 still runs on PayPal's resend, and the report says the replay path was not available.

## Repository layout

```
apps/api            Run API (Milestone 1: boot guard + /health)
apps/demo-stores    demo-store-good (buggy store comes in Milestone 5)
packages/config     Env loader: sandbox enforcement, secret-safe errors and printing
packages/paypal     The only PayPal client: sandbox-only, PayPal-Request-Id, audit log
docs/               Brief and technical design
```

## License

[MIT](LICENSE)
