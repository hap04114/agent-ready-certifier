# Roadmap

Deadline: **Nov 12, 2026, 12:00 PM PT**. CLAUDE.md milestones stay the backbone; additions below
are slotted where they depend on earlier work. Status is updated as work lands, never ahead of it.

## Status

| Milestone | Status |
| --- | --- |
| 1. Foundation | Done — sandbox order `8TA22286319557322` captured; PayPal and store agree |
| 2. Truth checker + Works | Done — W1–W6 all pass live on demo-store-good (run `b1a5a852`). W6 evidence: verified replay of the store's PayPal-signed delivery (PayPal's resend was refused; its fail-ack retry had not arrived by the end of the run) |
| 3–9 | Not started |

## Additions (requested Nov 9), by where they land

| # | Addition | Lands in | Depends on | Notes / constraints |
| --- | --- | --- | --- | --- |
| 1 | Duplicate delivery via PayPal's webhook **resend API** | M2 | — | Already how W6 works. Sandbox accepted the resend but did not deliver it. |
| 2 | **Recorded run** mode for judges | M7 (report) | Evidence store | Replays a stored run from Postgres; labelled "recorded", with its date and run ID. |
| 3 | **Kernel recording** attached to each browser check | M3 | `KERNEL_API_KEY` | Stored as evidence kind `video`. |
| 4 | Current pillar: PayPal button, Pay Later message, **Venmo** button | M3 / M7 | Browser agent | Venmo shows only to eligible US buyers/devices; "not offered" is reported as not applicable, never as a fail. |
| 5 | Planner **reasoning** shown per chosen test | M7 | Planner (M3/M4) | Reasoning is displayed text only; verdicts stay rule-based. |
| 6 | **Transaction Search** reconciliation across the run | M5+ | Transaction Search enabled on the app | PayPal documents a delay before transactions appear; a reconciliation that is not yet complete is "inconclusive", not "pass". |
| 7 | **Agent Toolkit** in the diagnosis agent (read live records) | M7 | Decision on rules 4 and 5 (below) | Open decision. |
| 8 | AI shopper with **two model providers** (A2 scorecard) | M6 | `LLM_API_KEY`, `GEMINI_API_KEY` | Scorecard reports the actual N per model. |
| 9 | Plain-language **business impact** line per finding | M7 | Diagnosis agent | Fixed phrases per check (e.g. "refund missed"); no dollar figures. |
| 10 | README table of **every PayPal product and API used** | M9 | — | Generated from what the code actually calls. |
| 11 | **Benchmark script**: each demo store ≥5 runs → `docs/benchmark.md` | M9 | Browser agent (no human approvals) | Measured numbers only. |
| 12 | **Real-world study**: 3–6 public open-source PayPal integrations deployed to our own sandbox staging → `docs/real-world-study.md` | M9 | M3–M5, license check per project | Only projects whose license allows deployment; only our own deployments are tested. |
| 13 | Stretch: **GitHub Action** that certifies a staging URL | After M9 | Hosted certifier | |

## Open decisions

- **Agent Toolkit in the diagnosis agent.** CLAUDE.md rule 5 says AI components never receive PayPal
  secrets; rule 4 says untrusted content (which includes item names and notes inside PayPal records)
  never reaches the diagnosis agent's instructions. Proposed: the toolkit runs inside our process with a
  read-only allow-list (get order / capture / refund), the model sees only IDs, statuses and amounts,
  and credentials never enter a prompt. Needs approval.
- **Scope vs. time.** Items 11 and 12 need the browser agent first and many sandbox runs.
