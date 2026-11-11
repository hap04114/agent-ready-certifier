# Roadmap and status

Deadline: **Nov 12, 2026, 12:00 PM PT** · feature freeze Nov 11 midday. Status is updated only for
what has actually run.

## Status (Nov 10, evening)

| Priority | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Milestone 4: ownership verifier, Run API, kill switch, in-process worker; Render live | **Done** | hosted run `da6fd45a` through the API (W1–W6 pass); a run on a store returning 502 was refused |
| 2 | Store-side checks C1–C5, S1–S8 | **Done, live** | run `1941d8af` on the hosted good store: 18/19 pass (C4 not applicable) |
| 3 | demo-store-buggy with the 8 seeded bugs | **Done, live** | run `4291cc0a`: all 8 seeded bugs caught (W4, W6+S3, S1, S2, S5, S7, S8, C2), no other failures |
| 4 | Agent-ready: R1, A1, A2 before/after, A3; Groq vs Gemini scorecard | **Live for Groq** (R1 5, A1 5, A2-inbox 5, A2-paypal 6, A3 5 trials); **Gemini partial** (R1 3, A1 5) | Gemini's free tier allows 20 requests per model per day; A2/A3 for Gemini pending |
| 5 | Report page + AG Grid console (runs, checks with evidence, scorecard, trials) | **Done, live** | https://certifier-api.onrender.com/ |
| 6 | Demo mode without keys, recorded-run view, keep-alive pings | **Done** | `/?demo=1`, run logs saved per run, `.github/workflows/keepalive.yml` |
| 7 | APIMatic ContextMatic diagnosis agent | **Done, live** | run `4291cc0a`: 9/9 failures grounded via ContextMatic `ask`; SDK methods verified via `endpoint_search` |
| 8 | Benchmark (≥5 runs per store) → `docs/benchmark.md` | **Running** | `pnpm benchmark` |
| — | README, Postman, LICENSE | **Done** | `README.md`, `postman/`, `LICENSE` |

## Remaining

1. Benchmark results → `docs/benchmark.md`, README numbers, demo snapshot refresh.
2. Gemini A2/A3 trials (quota) or a second model.
3. Demo video and Devpost submission (owner).
4. After judging: rotate keys pasted in chat; delete the `demo-store-buggy` sandbox app (its secret is public by design).

## Cut (per plan)

Passkeys, public hash log, signed certificate, Bryntum, Channel3, the GitHub Action certifier, the real-world
study, extra server-side scenarios, PayPal Agent Toolkit integration.
