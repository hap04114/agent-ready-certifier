# Roadmap and status

Deadline: **Nov 12, 2026, 12:00 PM PT** · feature freeze Nov 11 midday. Status is updated only for
what has actually run.

## Status (Nov 10)

| Priority | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Milestone 4: ownership verifier, Run API, kill switch, in-process worker; Render live | **Done** | hosted run `da6fd45a` through the API (W1–W6 pass); a run on a store returning 502 was refused |
| 2 | Store-side checks C1–C5, S1–S8 | **Done, live** | run `1941d8af` on the hosted good store: 18/19 pass (C4 not applicable) |
| 3 | demo-store-buggy with the 8 seeded bugs | **Built, unit-tested**; live once its sandbox app exists | `apps/demo-stores/src/good/buggy.test.ts` proves each bug |
| 4 | Agent-ready: R1, A1, A2 before/after, A3; Groq vs Gemini scorecard | **Built**; A1 live (2 trials per model) | A2/R1 need "Save payment methods" + `pnpm vault:setup`; A3 needs `LOOKALIKE_MERCHANT_EMAIL` |
| 5 | Report page + AG Grid console (runs, checks with evidence, scorecard, trials) | **Done, live** | https://certifier-api.onrender.com/ |
| 6 | Demo mode without keys, recorded-run view, keep-alive pings | **Done** | `/?demo=1`, run logs saved per run, `.github/workflows/keepalive.yml` |
| 7 | APIMatic ContextMatic diagnosis agent | **Built**; grounded after `pnpm apimatic:register` (MCP OAuth) | `packages/diagnosis` |
| 8 | Benchmark (≥5 runs per store) → `docs/benchmark.md` | **Script ready**; runs once the buggy store is live | `pnpm benchmark` |
| — | README, Postman, LICENSE | **Done** | `README.md`, `postman/`, `LICENSE` |

## Waiting on account setup

1. "Save payment methods" on the `demo-store-good` sandbox app → `pnpm vault:setup` → A2/R1 trials.
2. A sandbox app `demo-store-buggy` on its own business account → buggy store on Render → benchmark.
3. A second sandbox business account's email → A3.
4. `pnpm apimatic:register` → ContextMatic-grounded findings.

## Cut (per plan)

Passkeys, public hash log, signed certificate, Bryntum, Channel3, the GitHub Action certifier, the real-world
study, extra server-side scenarios, PayPal Agent Toolkit integration.
