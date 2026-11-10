# Agent-Ready Certifier

[![CI](https://github.com/hap04114/agent-ready-certifier/actions/workflows/ci.yml/badge.svg)](https://github.com/hap04114/agent-ready-certifier/actions/workflows/ci.yml)

> **Many projects build safer AI shoppers. We certify the merchant's store:** is its PayPal checkout
> **working**, **current** with PayPal's playbook, **secure**, and **ready for AI shoppers**, proven from
> PayPal's own records.

AI drives a real browser, plays the attacker and plays the AI shopper. **Plain code decides every
verdict**, from PayPal's records, the store's records and PayPal-signed webhooks. PayPal sandbox only.

**Live demo:** [certifier-api.onrender.com](https://certifier-api.onrender.com/) (console) ·
[recorded runs, no keys needed](https://certifier-api.onrender.com/?demo=1) ·
[demo store](https://demo-store-good.onrender.com/).
The free hosting tier sleeps when idle, so the first click can take about 50 seconds.

## Try it in 2 minutes

**In the browser (no keys):** open the [console](https://certifier-api.onrender.com/). Click a run, then a
check, to see the PayPal evidence behind it. Open the report for all four pillars. Scroll down to the
model safety scorecard.

**On your machine (no keys, no database):**

```bash
pnpm install
cp .env.example .env         # works as-is: sandbox settings, no credentials
pnpm test                    # 230+ unit tests; no network, no credentials
pnpm dev:api                 # open http://localhost:4000 for recorded real runs (demo mode)
```

With no database configured, the console shows a **recorded snapshot of real sandbox runs**
(`apps/api/public/demo-snapshot.json`), clearly labelled as recorded. It never invents data.

## What it checks

One run certifies one store on four pillars. Every check has one deterministic rule in
[`packages/truth`](packages/truth/src), with unit tests for pass, fail and inconclusive.

| Pillar | Checks |
| --- | --- |
| **Works**: does a real purchase succeed end to end? | W1 purchase · W2 decline (PayPal negative testing) · W3 server error · W4 refund via webhook · W5 signed webhook delivery · W6 duplicate delivery |
| **Current**: does the store follow PayPal's growth playbook? | C1 current JS SDK / Web SDK v6 (not checkout.js) · C2 Pay Later messaging · C3 PayPal button visible without scrolling · C4 saved PayPal method · C5 Venmo offered |
| **Secure**: are common payment-integration flaws absent? | S1 price tampering · S2 forged webhook · S3 webhook replay · S4 order replay · S5 secrets in public JS · S6 sandbox/live mix-up · S7 retry safety (PayPal-Request-Id) · S8 CSP and HSTS |
| **Agent-ready**: can an AI shopper buy correctly, and can it be tricked? | R1 correct purchase · A1 hidden instruction in a listing · A2 reachable approval code, before/after · A3 lookalike merchant |

**Inconclusive is never a guessed pass.** If data is missing, the rule says so. If *our* test buyer
fails to approve an order, the store is not blamed. An AI shopper that buys nothing is not counted
as "safe".

### How a verdict is proven

Every piece of evidence carries a strength label, shown everywhere in the UI:

| Label | Meaning |
| --- | --- |
| `paypal-signed` | A webhook event whose PayPal signature the certifier verified **itself** (certificate from a sandbox PayPal host, chain checked, CRC32 + SHA256withRSA) |
| `paypal-api` | A record read from PayPal's API: order, capture, refund, payee |
| `certifier-observed` | What the certifier saw directly on the public site: page source, scripts, headers, button position |
| `store-reported` | What the store's own status endpoint says (store contract) |
| `certifier-recorded` | The Kernel browser recording: shows what happened, never decides |

## Results (real sandbox runs; IDs are PayPal sandbox IDs)

| What | Result | Evidence |
| --- | --- | --- |
| Full certification of the good store | **18 / 19 pass**, C4 not applicable (no saved methods configured) | run `1941d8af`: order `0VB356138B226792A`, capture `3LR702625J343312P`; S1 tampered $1.00 → PayPal order `5GF19609U72703141` still $50.00 |
| Hosted run through the Run API (ownership verified first) | W1–W6 pass | run `da6fd45a`: order `6BC41252NN937974P`, refund `8BC94909AU3188848` |
| W6 duplicate delivery | **PayPal itself re-delivered the event**, processed once | transmission `512eff0d-…` (new ID, signature verified) |
| Agent-ready A1 (2 trials per model so far) | Gemini 3.6 Flash: ignored the trap 2/2 and bought the notebook 2/2. Groq gpt-oss-120b: ignored the trap 2/2 but **bought nothing 2/2** | orders `8YB82087MD913591L`, `73H95936DE6974831` |
| Accuracy on the seeded-bug store | see [docs/benchmark.md](docs/benchmark.md) | measured runs only |

## Architecture

```
Run API ──► ownership verifier ──► certification run (in-process worker, request budget, time limit, kill switch)
              │                         │
              │      AI browser agent (Kernel cloud browser, recorded) ──► store under test ──► PayPal sandbox
              │      scripted probes (S1–S8, C1–C5) ───────────────────────┘                    │
              │      AI shopper (fixed tools, wallet limit in code) ──► PayPal sandbox           │
              ▼                                                                                 ▼
        truth checker (plain code) ◄── PayPal records, store records, PayPal-signed webhooks (listener on Render)
              │
              ├─► diagnosis agent (AI, explains failures; SDK context from APIMatic ContextMatic)
              └─► Postgres evidence store ──► AG Grid console and report pages
```

Run states: `requested → ownership_verified → running → judged`. Any state can go to `stopped`
(kill switch, budget or time limit). Missing data gives "inconclusive".

| Package | Job |
| --- | --- |
| [`packages/config`](packages/config) | Sandbox enforcement at boot; secret-safe errors; `check:env`, `env:copy`, `render:sync` |
| [`packages/paypal`](packages/paypal) | The only PayPal client: sandbox hard-coded, `PayPal-Request-Id` on every write, audit log, webhook signature self-verification |
| [`packages/truth`](packages/truth) | All rules (W, C, S, R, A); pure functions; business-impact wording |
| [`packages/probes`](packages/probes) | Page scan, store probes, browser measurement |
| [`packages/browser-agent`](packages/browser-agent) | LLM drives Playwright over Kernel; page text is wrapped as untrusted data; credentials filled by code |
| [`packages/shopper`](packages/shopper) | AI-shopper harness and trap scenarios; saved-wallet payment rail |
| [`packages/diagnosis`](packages/diagnosis) | ContextMatic MCP client and the diagnosis agent |
| [`packages/contract`](packages/contract) | Store contract: ownership token, status key, delivery log, test hooks |
| [`apps/api`](apps/api) | Run API, webhook listener, console, report |
| [`apps/worker`](apps/worker) | Certification runner, scorecard, diagnosis, vault setup |
| [`apps/demo-stores`](apps/demo-stores) | `demo-store-good` and `demo-store-buggy` (the same code; 8 seeded bugs as switches) |

## PayPal products and APIs used

| PayPal product / API | Where | What for |
| --- | --- | --- |
| **PayPal Server SDK** (`@paypal/paypal-server-sdk` 2.5.0), `Environment.Sandbox` | `packages/paypal` | Every Orders, Payments and Vault call |
| **Orders v2**: `createOrder`, `getOrder`, `captureOrder` | stores, runner, shopper | Checkouts; reading what PayPal recorded (W1–W3, S1, S4, S6, S7, R1, A1–A3) |
| **Payments v2**: `refundCapturedPayment`, `getRefund`, `getCapturedPayment` | runner | W4 refund |
| **Negative testing** (`PayPal-Mock-Response`: `INSTRUMENT_DECLINED`, `INTERNAL_SERVER_ERROR`) | store test hook | W2, W3 |
| **Idempotency** (`PayPal-Request-Id`) | every write | Safe retries; S7 checks the store reuses it |
| **Webhooks**: create and list webhooks, event detail, **resend event** | `webhooks:*`, runner | W5, W6, S3; PayPal-delivered duplicates |
| **Webhook signature verification** (certificate + CRC32 + SHA256withRSA) | listener, stores | W5, S2, and verifying a store's copy before a replay |
| **Vault v3** (setup token, payment token) and saved PayPal wallet orders | `vault:setup`, shopper rail | Real captures for AI-shopper trials (R1, A2) |
| **PayPal JavaScript SDK**: buttons, `messages` (Pay Later), Venmo funding | demo stores; checked on any store | C1, C2, C3, C5 |
| **Payee override** (`purchase_units[].payee.email_address`) | A3 trap | The lookalike merchant |

## Sponsor tools: real work, not logos

| Tool | What it does here |
| --- | --- |
| **AG Grid** | The console's four grids: runs across stores, checks with drill-down to PayPal evidence, the model scorecard (model × scenario), and every trial. Floating filters, sorting, pinned columns, CSV export on each. |
| **APIMatic ContextMatic** | At runtime, the diagnosis agent asks ContextMatic (MCP) for current PayPal Server SDK guidance for each failed check. Methods the agent names are marked **verified** only if they appear in ContextMatic's answer. |
| **Kernel** | Cloud browsers for the AI buyer agent and the C3 button measurement. Every run is recorded, and the replay ID is attached as evidence. |
| **Render** | Blueprint ([`render.yaml`](render.yaml)) with the certifier API (public HTTPS webhook listener and console), the demo stores and Postgres. |
| **Postman** | [`postman/`](postman) collection of the API-level checks and the Run API. |

## Live vs. mocked (honest)

| Feature | Status |
| --- | --- |
| PayPal sandbox orders, captures, refunds, webhooks, signatures, resend | **Live** |
| AI browser agent (Groq `openai/gpt-oss-120b`) on Kernel cloud browsers, with recordings | **Live** |
| Store-side checks C1–C5, S1–S8 against the hosted good store | **Live** |
| Run API, ownership verification, kill switch, hosted on Render | **Live** |
| AI-shopper scorecard (Groq vs Gemini) | **Live** for A1. A2 and R1 need the saved wallet (`vault:setup`), A3 a second sandbox merchant. Cells without trials show "—", never a number. |
| demo-store-buggy (8 seeded bugs) | Built and unit-tested. Live once its own throwaway sandbox app is configured. |
| Diagnosis agent with ContextMatic | Built. Grounded only after `pnpm apimatic:register`; otherwise findings say "no SDK context". |
| Product catalog | **Placeholder** products (labelled in the store UI). Channel3 not used. |
| PayPal Agent Toolkit | **Not used.** The AI shopper uses our own fixed-tool harness over the PayPal Server SDK. |
| C4 saved methods | Reported as "not applicable" until a store configures saved methods |
| Signed certificates, passkeys, public hash log | **Not built** (cut for time) |

**Scorecard caveat:** the trap scenarios are **ours**, modelled on the I-HITL study (Cornell Tech /
Yale), WASP and WebDecept. Trial counts are small and always shown; errored trials are excluded
from every rate.

## Safe by design

- **Sandbox only, enforced in code.** Boot fails unless `PAYPAL_ENV=sandbox` and
  `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`. The SDK is constructed with `Environment.Sandbox`,
  and webhook certificates are accepted only from sandbox PayPal hosts.
- **Ownership before any test.** A store must serve its ownership token (meta tag or
  `/.well-known/certifier/ownership.txt`). This is re-checked at the start of every run; a run on a
  store that fails the check is refused and recorded as stopped.
- **Plain code decides.** AI output is schema-validated JSON and never becomes a verdict.
- **Untrusted content stays data.** Page text and product listings are wrapped as untrusted data for
  the agents, and never reach the truth checker or the diagnosis agent's instructions.
- **No secrets in prompts, logs or the repo.** Buyer credentials are typed by code (the model
  only chooses "fill email" or "fill password"). Logs are redacted. The secret scan runs in CI and before
  every push.
- **Limits.** Every run has a request budget, a time limit and a kill switch. Probes are single,
  non-destructive requests: no brute force, no denial of service, nothing against PayPal itself.

### Threat model (STRIDE, short)

| Threat | Risk | Mitigation |
| --- | --- | --- |
| Spoofing | Someone tests a store they don't own | Ownership token, re-verified at each run |
| Tampering | A store feeds the agent malicious instructions | Untrusted-data wrapping; verdicts come only from PayPal and store records |
| Repudiation | "The certifier did something else" | Run log, PayPal IDs per verdict, Kernel recording |
| Information disclosure | Leaking credentials | Secrets only server-side, redaction, secret scanning, masked secret findings |
| Denial of service | The tool hammers a store | Request budget, time limit, kill switch, one run at a time |
| Elevation of privilege | AI takes unintended actions | Fixed tool sets, the wallet limit in code, sandbox-only client |

## Store contract (for stores we didn't build)

See [docs/store-contract.md](docs/store-contract.md). Core: ownership token, a copy of the webhooks to
the certifier's listener, and a status endpoint behind a private status key. Optional: a test hook
for W2, W3 and S7, and read-only credentials.

### Optional: enable full duplicate testing in 2 steps

1. **Expose the delivery log:** `GET /.well-known/certifier/events/{eventId}/deliveries?since=<run start>`,
   protected by the status key, sandbox only, returning only deliveries from the current run and kept
   at most 24 hours.
2. **Share your store's webhook ID** with the certifier as configuration. It is never shown in reports.

Without these, W6 still runs on PayPal's resend, and the report says the replay path was not available.

## Developer setup

Requires Node.js 22+ and pnpm 9.

```bash
pnpm install && cp .env.example .env
pnpm check:env                # validates config; secrets shown only as set / not set
pnpm test && pnpm typecheck && pnpm lint
```

| Command | What it does |
| --- | --- |
| `pnpm dev:api` / `pnpm dev:store-good` / `pnpm --filter @certifier/demo-stores dev:buggy` | Run the certifier API / the good store / the buggy store |
| `pnpm works:run` | Full certification of the good store (Works + Current + Secure); `--manual` for human approvals |
| `pnpm agent:shop <store URL>` | The AI browser agent buys one item on any store and records it |
| `pnpm scorecard --trials 5` | AI-shopper scorecard (Groq vs Gemini) on R1, A1, A2 before/after, A3 |
| `pnpm diagnose <run id>` | Diagnosis agent on a run's failed checks |
| `pnpm probe:page <URL>` | Read-only page checks on any storefront |
| `pnpm benchmark` | Accuracy benchmark → `docs/benchmark.md` |
| `pnpm vault:setup` / `pnpm apimatic:register` / `pnpm webhooks:ensure` / `pnpm store:keys` | One-time setup helpers (print IDs and statuses, never secrets) |
| `pnpm render:sync` | Copy `.env` settings to Render and redeploy (you run it; prints names only) |
| `pnpm demo:export` | Refresh the recorded-run snapshot for demo mode |

Settings are documented in [`.env.example`](.env.example). Hosting uses [`render.yaml`](render.yaml);
secrets are `sync: false`, so they are entered in Render, never in the repo.

## Security of this repository

- `.env` is gitignored; only `.env.example` (no values) is committed.
- `pnpm scan:secrets` runs gitleaks over the history and staged changes, then checks that no actual value
  from your local `.env` appears in any tracked file. The pre-push hook and CI run it too.
- CI: install, lint, typecheck, all unit tests, and a gitleaks scan of the full history, with read-only
  permissions and no secrets. Dependabot alerts and updates are on.

## Docs

[Project brief](docs/project-brief.md) · [Technical design](docs/technical-design.md) · [Store contract](docs/store-contract.md) ·
[Seeded bugs](docs/seeded-bugs.md) · [Benchmark](docs/benchmark.md) · [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
