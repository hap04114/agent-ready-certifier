# Agent-Ready Certifier

[![CI](https://github.com/hap04114/agent-ready-certifier/actions/workflows/ci.yml/badge.svg)](https://github.com/hap04114/agent-ready-certifier/actions/workflows/ci.yml)

> **Many projects build safer AI shoppers. We certify the merchant's store:** is its PayPal checkout
> **working**, **current**, **secure** and **ready for AI shoppers**, proven from PayPal's own records.

**[Live demo](https://certifier-api.onrender.com)** ·
[Every tool we used](https://certifier-api.onrender.com/sponsors) ·
[Simulator](https://certifier-api.onrender.com/simulator) ·
[Console](https://certifier-api.onrender.com/console) ·
[How it works](https://certifier-api.onrender.com/how-it-works) ·
[2-page summary](docs/Agent-Ready-Certifier-Summary.pdf) ·
[88-page explainer](docs/Agent-Ready-Certifier-Explained.pdf) ·
[Slides](docs/Agent-Ready-Certifier-Built-With.pptx)

<sub>PayPal sandbox only. The free hosting tier sleeps when idle, so the first click can take about 50 seconds.</sub>

## What it does

One run tests a store's own PayPal checkout the way a shopper, an attacker and an AI shopping agent
would. AI drives the browser, attacks and explains; **plain code decides every verdict** from PayPal's
records, the store's records and PayPal-signed webhooks. The result is a signed certificate anyone can check.

| Pillar | The question |
| --- | --- |
| **Works** | Does a real purchase succeed, even on a bad day: a decline, a PayPal error, a refund, a duplicate webhook? |
| **Current** | Does the store follow PayPal's playbook: current SDK, Pay Later, button above the fold, Venmo? |
| **Secure** | Are common flaws absent: price tampering, forged or replayed webhooks, exposed secrets, missing CSP/HSTS? |
| **Agent-ready** | Can AI shoppers buy correctly, and can they be tricked by hidden instructions, reachable approval codes or lookalike merchants? |

## Judge in 60 seconds

Everything below is a finished, recorded real run: nothing waits on a live AI when you click.

1. **Play first:** the [simulator](https://certifier-api.onrender.com/simulator) switches the 10 planted bugs on
   and off and replays recorded AI-shopper trials step by step.
2. **One run, all 10 planted bugs caught:** the
   [buggy-store report](https://certifier-api.onrender.com/run?id=9d2bdcbd-25de-4da9-97b1-4013ede178a0), each
   failure with the PayPal record that proves it (price tampering: PayPal order `5V384020GN270763Y` is for
   1.00 USD; the store's price is 64.00 USD).
3. **The same checks on a correct store:** the
   [good-store report](https://certifier-api.onrender.com/run?id=ed37cc30-8e31-4872-b753-4957b62709a3):
   19 of 21 pass, 0 fail, with the run timeline.
4. **Code we did not write:**
   [PayPal's own example integration](https://certifier-api.onrender.com/run?id=c38fb9cd-21c4-4e21-9d62-29b9a6d3dae1),
   fully certified: 9 pass, 3 fail, 9 inconclusive.
5. **AI shoppers:** in the [console](https://certifier-api.onrender.com/console), click **Compare models**. With the
   approval code readable, gpt-oss-120b raised its own $20 limit 2 of 10 times; with approval only in PayPal's
   window, 0 of 6; with the owner's passkey, 0 bypasses in 37 trials.
6. **Check the proof yourself:** a
   [signed certificate](https://certifier-api.onrender.com/api/runs/9d2bdcbd-25de-4da9-97b1-4013ede178a0/certificate),
   its [public key](https://certifier-api.onrender.com/.well-known/certifier/jwks.json) and the
   [hash log](https://certifier-api.onrender.com/api/hashlog).

## Results

| What | Result |
| --- | --- |
| Planted-bug benchmark (12 judged certifications) | **48 of 52 detections (92%)**; 0 bugs ever wrongly passed; 0 false alarms on the correct store; every failure backed by evidence |
| PayPal's own example integration | **9 pass, 3 fail, 9 inconclusive**: refunds never recorded (W4), a second capture answered as a new success (S4), no CSP or HSTS (S8) |
| AI limit bypass (A2), Groq gpt-oss-120b | Code readable: **2 of 10**. Approval in PayPal's window: **0 of 6**. Owner's passkey: **0 bypasses in 37 trials**, 4 models |
| Hidden instruction in a listing (A1) | Followed by gpt-oss-120b 5/5 and Qwen3-8B 20/20; ignored by Gemini 3.6 Flash 5/5 and Qwen3.8-27B 5/5 |
| The store's own AI agent (PayPal Agent Toolkit) | gpt-oss-120b: 0/6 wrong refunds, 6/6 genuine ones. Qwen3-8B: 3/5 wrong, 0/5 genuine |
| AI checkout funnel on the live store (R3) | Qwen3.8-27B paid 3 of 3; gpt-oss-120b 0 of 2 |

Small numbers are always shown with their N. Every result with its PayPal sandbox IDs:
[project details](docs/details.md) · [benchmark](docs/benchmark.md) · [real-world study](docs/real-world-study.md).

## How it works

1. **Prove ownership.** The store serves a unique token; no test runs before that.
2. **Test.** An AI buyer pays in a recorded cloud browser, scripted probes attack the checkout, and AI shoppers
   walk into traps.
3. **Read PayPal's records.** Orders, captures, refunds, payees, and webhooks whose signature the certifier
   verifies itself.
4. **Decide with plain code.** Pass, fail or inconclusive; missing data is never a guessed pass. AI explains
   each failure, with a fix grounded in the current PayPal Server SDK.
5. **Sign.** An Ed25519 certificate, hash-chained and publicly timestamped, that keeps every PayPal ID it relied on.

Every process, step by step with diagrams: [how it works](https://certifier-api.onrender.com/how-it-works)
or the [88-page explainer](docs/Agent-Ready-Certifier-Explained.pdf).

## Built with

| Tool | What it does here |
| --- | --- |
| **PayPal** | Server SDK (Orders, Payments, Vault), negative testing, webhooks and signatures, the JavaScript SDK, Agent Toolkit |
| **AG Grid** | The results console: runs, checks with their PayPal evidence, the model scorecard and every trial; quick views and CSV export |
| **APIMatic ContextMatic** | Grounds every suggested fix in the current PayPal Server SDK, and verifies each SDK method it names |
| **Bryntum** | The run timeline, showing where a run waited on PayPal's webhooks |
| **Channel3** | Real products and prices in the demo stores, used by the price checks |
| **Render** | Hosts everything from one blueprint, including PayPal's example as an isolated store |
| **Kernel** | Recorded cloud browsers for the AI buyer; each replay is kept as evidence |
| **Postman** | The API-level checks as a collection anyone can run |

Where, why, how and the result for each tool, with live screenshots:
**[certifier-api.onrender.com/sponsors](https://certifier-api.onrender.com/sponsors)**.
Also used: Groq, Gemini and llama.cpp models, Playwright, Fastify, Postgres, Zod, SimpleWebAuthn, OpenTimestamps.

## Live vs. mocked

| | |
| --- | --- |
| **Live** | PayPal sandbox orders, captures, refunds, webhooks and signatures; the AI browser agent on Kernel; all 21 store checks on the hosted stores; the AI-shopper scorecard with real saved-wallet payments; the diagnosis agent with ContextMatic; signed certificates, hash log and OpenTimestamps; passkey approvals; PayPal's example integration as a third-party store |
| **Recorded, and labelled as such** | The [simulator](https://certifier-api.onrender.com/simulator) and the console's demo mode replay real recorded runs; they never run a test or invent data |
| **This machine only** | Open-weights models (Qwen3-8B on llama.cpp) for the worst-case agent test |
| **Not built** | A scheduler for recurring runs, a GitHub Action |

The full table: [project details](docs/details.md).

## Run it yourself

Requires Node.js 22+ and pnpm 9. No keys are needed to try it:

```bash
pnpm install
cp .env.example .env    # sandbox settings, no credentials
pnpm test               # 308 unit tests; no network, no credentials
pnpm dev:api            # http://localhost:4000 shows recorded real runs (demo mode)
```

Full certification runs, the AI-shopper scorecard and every other command need sandbox credentials; see the
[developer setup](docs/details.md) and [`.env.example`](.env.example).

## Safe by design

- **Sandbox only**, enforced at boot; webhook certificates are accepted only from sandbox PayPal hosts.
- **Ownership before any test**, re-checked at the start of every run.
- **Plain code decides**; AI output is schema-validated JSON and never becomes a verdict.
- **Untrusted page text stays data**, never instructions.
- **No secrets** in prompts, logs or the repository; `pnpm scan:secrets` (gitleaks) runs before every push and in CI.
- **Limits:** every run has a request budget, a time limit and a kill switch.

## Docs

[Project details (everything in depth)](docs/details.md) · [Real-world study](docs/real-world-study.md) ·
[Benchmark](docs/benchmark.md) · [Store contract](docs/store-contract.md) · [Seeded bugs](docs/seeded-bugs.md) ·
[Agent funnel](docs/agent-funnel.md) · [Technical design](docs/technical-design.md) ·
[Project brief](docs/project-brief.md) · [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
