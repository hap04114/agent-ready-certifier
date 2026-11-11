# Roadmap and status

Deadline: **Nov 12, 2026, 12:00 PM PT** · feature freeze Nov 11, 5:00 PM ET. Status is updated only for
what has actually run.

## Status (Nov 11, morning)

| Priority | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Milestones 1–4: sandbox client, truth checker, Works pillar, browser agent on Kernel, ownership verifier, Run API, kill switch; Render live | **Done** | hosted run `da6fd45a` through the API (W1–W6 pass); a run on a store returning 502 was refused |
| 2 | Store-side checks C1–C5, S1–S8, A4, A5 | **Done, live** | good store run `ed37cc30`: 19/21 pass, 0 fail; A4/A5 runs `35f67232` (good), `e479a754` (buggy) |
| 3 | demo-store-buggy with the 10 seeded bugs | **Done, live** | run `9d2bdcbd`: all 10 seeded bugs caught |
| 4 | Agent-ready scorecard: R1, A1, A2 (inbox code / PayPal window / passkey), A3 | **Live** for Groq gpt-oss-120b, Qwen3.8-27B, local Qwen3-8B and the refusal-removed Qwen3-8B; Gemini partial (free-tier quota) | console scorecard; README results table |
| 5 | Store's own AI agent on PayPal Agent Toolkit: A6 (injected refund), R2 (genuine refund) | **Done, live** | Groq 0/6 wrong refunds, 6/6 genuine; Qwen3-8B 3/5 wrong, 0/5 genuine; refusal-removed 0/5 wrong, 5/5 genuine |
| 6 | R3 agent checkout funnel on the real store | **Done**; gpt-oss-120b not measured yet (daily quota) | [agent-funnel.md](agent-funnel.md): Qwen3.8-27B paid 3/3 |
| 7 | Passkey owner approvals (A2-passkey) | **Built and live** on `/owner`; tests with a software authenticator; real-device trials pending the owner's registration | `pnpm passkey:invite`, then `pnpm scorecard --scenarios A2-passkey` |
| 8 | Report page + AG Grid console (runs, checks with evidence, scorecard, trials) | **Done, live** | https://certifier-api.onrender.com/ |
| 9 | APIMatic ContextMatic diagnosis agent | **Done, live** | failures grounded via ContextMatic `ask`; SDK methods verified via `endpoint_search` |
| 10 | Trust layer: Ed25519 certificates, hash log, OpenTimestamps | **Done, live** | `/api/runs/9d2bdcbd-…/certificate`, `/api/hashlog` |
| 11 | Channel3 catalog, Bryntum run timeline | **Done, live** | demo stores show Channel3 products; timeline on run `ed37cc30` |
| 12 | Real-world study (PayPal's own example, page level) | **Done** | [real-world-study.md](real-world-study.md) |
| 13 | Benchmark | **Done** | [benchmark.md](benchmark.md): 48/52 detections, 0 wrongly passed, 0 false alarms |
| — | README, Postman (incl. trust and passkey folders), LICENSE | **Done** | `README.md`, `postman/`, `LICENSE` |

## Remaining

1. A2-passkey trials with the owner's real passkey; gpt-oss-120b A2-passkey and funnel trials when its quota allows.
2. Demo snapshot refresh (`pnpm demo:export`) and the explainer PDF refresh.
3. Demo video and Devpost submission (owner).
4. Before making the repo public: full-history secret scan (`pnpm scan:secrets`).
5. After judging: rotate keys that were pasted in chat (Kernel on hold until the owner says so); delete the
   `demo-store-buggy` and real-world-study sandbox apps (the buggy store's secret is public by design).

## Not built

The GitHub Action certifier, Bryntum recurring-run scheduler, live (non-sandbox) anything.
