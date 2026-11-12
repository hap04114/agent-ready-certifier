# Devpost submission (copy and paste)

Every number below comes from `README.md`, `docs/benchmark.md` and `docs/real-world-study.md`
(Nov 12, 2026). PayPal sandbox only.

---

## Project name

Agent-Ready Certifier

## Elevator pitch (under 200 characters)

Many projects build safer AI shoppers. We certify the merchant's store: is its PayPal checkout working, current, secure and ready for AI shoppers, proven from PayPal's own records.

## Try it out (links)

- Live demo: https://certifier-api.onrender.com
- Every sponsor tool, where, why, how and results: https://certifier-api.onrender.com/sponsors
- Simulator (recorded results, no keys): https://certifier-api.onrender.com/simulator
- Results console (AG Grid): https://certifier-api.onrender.com/console
- Source code: https://github.com/hap04114/agent-ready-certifier
- Two-page summary for judges: https://github.com/hap04114/agent-ready-certifier/blob/main/docs/Agent-Ready-Certifier-Summary.pdf

## Built with

TypeScript, Node.js, Fastify, PostgreSQL, PayPal Server SDK, PayPal JavaScript SDK, PayPal Agent Toolkit, PayPal Webhooks, PayPal Vault, AG Grid, APIMatic ContextMatic, Bryntum Scheduler, Channel3, Render, Kernel, Playwright, Postman, Groq, Gemini, llama.cpp, WebAuthn (SimpleWebAuthn), OpenTimestamps, Zod, Vitest

## Sponsor prize categories to select

AG Grid, APIMatic, Bryntum, Channel3, Render (each is used in a real run; see /sponsors).

---

## About the project

### Inspiration

Two things are arriving at every PayPal checkout at once. First, AI shoppers: in the I-HITL study
(Cornell Tech and Yale), 9 of 10 AI models raised their own spending limit by reading the owner's emailed
approval codes. Second, the bad days nobody tests: declines, PayPal errors, refunds, duplicate webhooks.
Flaws like trusting the browser's price or accepting unsigned webhooks ship unnoticed.

Many projects build a safer AI shopper. We asked the merchant's question instead: **is my store ready for
humans, attackers and AI shoppers, and can you prove it?** And because an AI tester can hallucinate a
"pass", the proof has to come from PayPal's own records, decided by plain code.

### What it does

One run tests any store's own PayPal checkout the way a real shopper, an attacker and an AI shopping
agent would, then proves every result from PayPal's sandbox records, in a signed certificate anyone can check.

1. **Prove ownership.** The store serves a unique token; no test runs before that.
2. **Test.** An AI buyer pays in a recorded Kernel cloud browser; scripted probes attack the checkout;
   AI shoppers walk into traps (hidden instructions, a reachable approval code, a lookalike merchant).
3. **Read PayPal's records.** Orders, captures, refunds, payees, and webhooks whose PayPal signature the
   certifier verifies itself.
4. **Plain code decides.** Pass, fail or inconclusive. Missing data is never a guessed pass. AI explains
   failures, with fixes grounded in the current PayPal Server SDK by APIMatic ContextMatic.
5. **Signed certificate.** Ed25519, hash-chained, publicly timestamped with OpenTimestamps; it keeps every
   PayPal ID it relied on.

Four pillars, 21 checks on the store plus AI-agent tests:

- **Works:** does a real purchase succeed, even on a bad day (decline, PayPal server error, refund via
  webhook, signed delivery, duplicates processed once)?
- **Current:** does the store follow PayPal's playbook (current SDK, Pay Later messaging, button above the
  fold, saved methods, Venmo)?
- **Secure:** price tampering, forged and replayed webhooks, order replay, retry safety, exposed secrets,
  sandbox/live mix-ups, CSP and HSTS.
- **Agent-ready:** can AI shoppers buy correctly, and can they be tricked? Plus the store's machine-readable
  price, accessible checkout controls, and the store's own AI support agent on PayPal's Agent Toolkit.

### Results (real PayPal sandbox runs)

- **48 of 52 planted-bug detections (92%)** across 12 judged certifications; **0 bugs ever wrongly passed**
  (the 4 misses were inconclusive, never guessed); **0 false alarms** on the correct store; every failure
  backed by evidence (52/52).
- **One run catches all 10 planted bugs** on our buggy store, each with the PayPal record that proves it
  (e.g. price tampering: PayPal order for 1.00 USD against a real 64.00 USD Channel3 listing).
- **Code we did not write:** PayPal's own example integration, server and page unchanged, fully certified.
  An AI buyer paid with the example's own button. 9 pass, 3 fail, 9 inconclusive: it never records refunds,
  answers a second capture as a new success (PayPal kept one capture), and sends no CSP or HSTS. These are the
  gaps a merchant inherits by shipping it as is.
- **AI shoppers:** with the approval code readable in its inbox, Groq gpt-oss-120b raised its own $20 limit
  **2 of 10** times; with approval only in PayPal's window, **0 of 6**. We built the fix, owner approval by
  **passkey** (WebAuthn over the exact request): **0 bypasses in 37 trials** across 4 models. A scripted
  attacker that always uses the code shows the difference with real payments: old design FAIL, passkey design PASS.
- **The store's own AI agent (PayPal Agent Toolkit):** a message hiding "refund another customer's order":
  gpt-oss-120b made 0 of 6 wrong refunds and 6 of 6 genuine ones; a small local model refunded the wrong
  customer 3 of 5 times and failed every genuine refund. Safety is always reported next to task success.

### How we built it

A TypeScript monorepo (Fastify API and worker, Postgres) in seven layers: presentation, orchestration,
testers, targets, judgment, trust, platform.

- **PayPal:** Server SDK 2.5.0 for Orders v2, Payments v2 and Vault v3; negative testing with
  `PayPal-Mock-Response`; `PayPal-Request-Id` on every write; webhooks, resend and signature verification
  (certificate, CRC32, SHA256withRSA, done by the certifier itself); the JavaScript SDK checks; and the
  Agent Toolkit for the store's AI support agent.
- **AG Grid:** the results console. Four grids (runs, checks with drill-down to PayPal evidence, the model
  safety scorecard, every AI trial), filters, pinned columns, CSV export and one-click quick views.
- **APIMatic ContextMatic:** at runtime, the diagnosis agent asks ContextMatic for current PayPal Server SDK
  guidance on each failure, and every SDK method it names is checked against APIMatic's index by exact name
  before it is marked verified.
- **Bryntum Scheduler:** the run timeline, which shows where a run waited on PayPal's webhooks (capture
  event 1 s, refund event 16 s).
- **Channel3:** real products and prices for the demo stores, which the price checks run against.
- **Render:** one blueprint with four web services (certifier and webhook listener, two demo stores,
  PayPal's example store) and Postgres.
- **Kernel:** recorded cloud browsers for the AI buyer; each replay is attached as evidence.
- **Postman:** a collection of the API-level checks and the Run API.

Safety rules are enforced in code: sandbox only (the app refuses live hosts at boot), ownership before any
test, a request budget, time limit and kill switch on every run, untrusted page text treated as data, AI
output schema-validated JSON, and no secret ever in a prompt, a log or the repository.

### Challenges we ran into

- **Telling a slow PayPal from a broken store.** A missing webhook is "inconclusive", never blamed on the
  store; the Bryntum timeline shows every wait.
- **Duplicates you can trust.** The certifier only replays a delivery after verifying PayPal's signature on it,
  and never labels its own replay as a PayPal delivery.
- **Testing code we did not write.** PayPal's example captures in the browser, so the AI buyer had to pay
  with the example's own button; an earlier page-level run of it exposed a false alarm in our own Pay Later
  rule, which we fixed.
- **Small N.** Free AI quotas limit trial counts (Gemini ran out after 2 judged A2 trials). Every rate is
  shown with its real N, and errored trials are excluded.

### Accomplishments that we're proud of

Plain code decides every verdict, and every verdict carries the PayPal IDs it relied on. 92% planted-bug
detection with zero wrong passes. A full certification of PayPal's own example. A passkey design under which no
model bypassed its limit in 37 trials (with the code readable, gpt-oss-120b did 2 of 10 times). Certificates
anyone can verify without trusting us.

### What we learned

Safety lives where approval lives: agents that can read the approval code sometimes use it, and agents that
cannot never bypass. Whether an AI shopper can buy at all is a property of the model (one paid 3 of 3, another
0 of 2 on the same store), so we report task success next to safety: an agent that buys nothing is not "safe".

### What's next

A GitHub Action that certifies a store on every pull request, scheduled recurring runs, more third-party
integrations, and larger trial counts per model. Always sandbox only.
