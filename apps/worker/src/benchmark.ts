/**
 * `pnpm benchmark [--runs 5] [--stores good,buggy]` — run fresh certifications and measure the
 * certifier's accuracy against the seeded-bug answer key (docs/seeded-bugs.md).
 * `pnpm benchmark --from-db [--since 2026-11-10T20:00:00Z]` — rebuild the report from full
 * certification runs already stored in the evidence database (no new runs).
 * Either way it writes docs/benchmark.md. Metrics: detection rate (seeded bugs whose checks failed
 * with evidence), missed bugs and HOW they were missed (inconclusive vs wrongly passed), false
 * alarms, evidence rate, AI-buyer completion and median run time. Every number comes from real
 * sandbox runs stored in the evidence database; nothing is invented.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, bootConfig, findRepoRoot, requireConfig } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { type Provider, fallbackModelsOf } from "@certifier/llm";
import type { CheckCode, EvidenceRef, Verdict } from "@certifier/truth";
import { RunBudget } from "./budget.js";
import { type StoreName, storeProfile } from "./stores.js";
import { runWorksPillar } from "./works.js";

/** The answer key: each seeded bug and the check(s) that must fail because of it. */
export const ANSWER_KEY: Record<string, string[]> = {
  refund_webhook_broken: ["W4"],
  trust_client_price: ["S1"],
  accept_unsigned_webhooks: ["S2"],
  no_webhook_dedup: ["S3", "W6"],
  expose_client_secret: ["S5"],
  no_request_id_on_retry: ["S7"],
  no_security_headers: ["S8"],
  no_pay_later: ["C2"],
  agent_price_mismatch: ["A4"],
  unlabeled_controls: ["A5"],
};
const SEEDED_CHECKS = new Set(Object.values(ANSWER_KEY).flat());
/** A full certification judges at least the original 19 store checks (Works-only runs are excluded). */
const FULL_RUN_MIN_CHECKS = 19;

const config = bootConfig("benchmark");
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : d;
};
const fromDb = process.argv.includes("--from-db");
const since = arg("since", "2026-11-10T20:00:00Z");
const runsPerStore = Math.max(1, Math.min(10, Number(arg("runs", "5"))));
// Split on commas OR spaces: PowerShell turns `--stores good,buggy` into one "good buggy" argument.
const stores = arg("stores", "good,buggy")
  .split(/[\s,]+/)
  .filter(Boolean) as StoreName[];
const unknown = stores.filter((s) => s !== "good" && s !== "buggy");
if (unknown.length || stores.length === 0) {
  console.error(`benchmark: unknown store name(s): ${unknown.join(", ") || "(none given)"}; use good and/or buggy`);
  process.exit(2);
}

let dbUrl: string;
let agent: Parameters<typeof runWorksPillar>[0]["agent"];
try {
  ({ DATABASE_URL: dbUrl } = requireConfig(config, "benchmark", ["DATABASE_URL"]));
  if (!fromDb) {
    requireConfig(config, "benchmark", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
    const a = requireConfig(config, "the browser agent", ["KERNEL_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_API_KEY", "PAYPAL_SANDBOX_BUYER_EMAIL", "PAYPAL_SANDBOX_BUYER_PASSWORD"]);
    agent = {
      kernelApiKey: a.KERNEL_API_KEY,
      llm: { provider: a.LLM_PROVIDER as Provider, model: a.LLM_MODEL, apiKey: a.LLM_API_KEY, fallbackModels: fallbackModelsOf(config.LLM_FALLBACK_MODELS) },
      buyer: { email: a.PAYPAL_SANDBOX_BUYER_EMAIL, password: a.PAYPAL_SANDBOX_BUYER_PASSWORD },
    };
  }
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

interface Row {
  store: StoreName;
  runId: string;
  status: string;
  seconds: number;
  verdicts: Verdict[];
}
const rows: Row[] = [];
const db = createPgDb(dbUrl);
const repo = certifierRepo(db);
try {
  await migrateCertifier(db);
  if (fromDb) {
    const origin = (u: string) => new URL(u).origin;
    const storeOf = (url: string): StoreName | undefined =>
      origin(url) === origin(config.DEMO_STORE_GOOD_URL) ? "good" : origin(url) === origin(config.DEMO_STORE_BUGGY_URL) ? "buggy" : undefined;
    const listed = (await repo.listRuns(500)).filter((r) => new Date(r.started_at) >= new Date(since)).reverse();
    for (const r of listed) {
      const store = storeOf(r.store_url);
      if (!store || !stores.includes(store)) continue;
      const run = await repo.getRun(r.id);
      if (!run) continue;
      // Judged runs that are not full certifications (e.g. Works-only API runs) are left out.
      if (run.status === "judged" && run.checks.length < FULL_RUN_MIN_CHECKS) continue;
      const verdicts: Verdict[] = run.checks.map((c) => ({
        check: c.code as CheckCode,
        status: c.status as Verdict["status"],
        summary: c.summary,
        reasons: c.reasons,
        evidence: c.evidence.map((e) => ({ kind: e.kind, id: e.id, strength: e.strength, note: e.note ?? undefined }) as EvidenceRef),
      }));
      const seconds = run.finished_at ? Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000) : 0;
      rows.push({ store, runId: run.id, status: run.status, seconds, verdicts });
    }
    console.log(`benchmark: compiled ${rows.length} stored run(s) since ${since}`);
  } else {
    for (const store of stores) {
      const profile = storeProfile(config, store);
      if ("missing" in profile) {
        console.warn(`skipping the ${store} store: needs ${profile.missing.join(", ")}`);
        continue;
      }
      for (let n = 1; n <= runsPerStore; n++) {
        console.log(`\n[${store} ${n}/${runsPerStore}]`);
        const started = Date.now();
        const r = await runWorksPillar({
          config,
          repo,
          budget: new RunBudget(config.RUN_MAX_REQUESTS, config.RUN_MAX_MINUTES),
          ...profile,
          certifierWebhookUrl: config.WEBHOOK_PUBLIC_URL,
          agent,
          log: (l) => console.log(`  ${l}`),
        });
        rows.push({ store, runId: r.runId, status: r.status, seconds: Math.round((Date.now() - started) / 1000), verdicts: r.verdicts });
        console.log(`  → run ${r.runId} ${r.status}: ${r.verdicts.filter((v) => v.status === "fail").map((v) => v.check).join(", ") || "no failures"}`);
      }
    }
  }
} finally {
  await db.close();
}

// ------------------------------------------------------------------ metrics
const strongEvidence = (v: Verdict) => v.evidence.some((e) => e.strength !== "certifier-recorded");
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : Math.round((s[s.length / 2 - 1]! + s[s.length / 2]!) / 2);
};
const judged = rows.filter((r) => r.status === "judged");
const buggy = judged.filter((r) => r.store === "buggy");
const good = judged.filter((r) => r.store === "good");
const statusOf = (r: Row, c: string) => r.verdicts.find((v) => v.check === c)?.status;

const perBug = Object.entries(ANSWER_KEY).map(([bug, checks]) => {
  // Only runs that judged every check mapped to this bug (A4/A5 exist only in newer runs).
  const tested = buggy.filter((r) => checks.every((c) => r.verdicts.some((v) => v.check === c)));
  const found = tested.filter((r) => checks.every((c) => r.verdicts.some((v) => v.check === c && v.status === "fail" && strongEvidence(v))));
  const missed = tested.filter((r) => !found.includes(r));
  const missedAsPass = missed.filter((r) => checks.some((c) => statusOf(r, c) === "pass")).length;
  return { bug, checks, found: found.length, of: tested.length, missedInconclusive: missed.length - missedAsPass, missedAsPass };
});
const detections = perBug.reduce((s, b) => s + b.found, 0);
const possible = perBug.reduce((s, b) => s + b.of, 0);
const wronglyPassed = perBug.reduce((s, b) => s + b.missedAsPass, 0);
const falseAlarms = (rs: Row[]) => rs.flatMap((r) => r.verdicts.filter((v) => v.status === "fail" && (r.store === "good" || !SEEDED_CHECKS.has(v.check))).map((v) => `${v.check} (run ${r.runId.slice(0, 8)})`));
const allFails = judged.flatMap((r) => r.verdicts.filter((v) => v.status === "fail"));
const evidenced = allFails.filter(strongEvidence).length;
// The AI buyer completed its approvals when W1 (the purchase) could be judged at all.
const buyerDone = (rs: Row[]) => rs.filter((r) => statusOf(r, "W1") !== undefined && statusOf(r, "W1") !== "inconclusive").length;

const pct = (k: number, n: number) => (n === 0 ? "n/a" : `${k}/${n} (${Math.round((100 * k) / n)}%)`);
const started = (s: StoreName) => rows.filter((r) => r.store === s).length;
const md = [
  "# Benchmark: certifier accuracy on seeded bugs",
  "",
  fromDb
    ? `Compiled ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from every full certification of the hosted demo stores stored in the evidence database since ${since} (PayPal sandbox; AI buyer agent in Kernel cloud browsers). Generated by \`pnpm benchmark --from-db\`; every number below comes from those runs.`
    : `Measured ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC on the hosted demo stores (PayPal sandbox), with the AI buyer agent approving every order in a Kernel cloud browser. Generated by \`pnpm benchmark\`; every number below comes from these runs.`,
  "",
  "## Summary",
  "",
  "| Metric | Result |",
  "| --- | --- |",
  `| Runs judged | good store: ${good.length} of ${started("good")} started, buggy store: ${buggy.length} of ${started("buggy")} started |`,
  `| **Detection rate** (seeded bug's checks failed, with evidence) | **${pct(detections, possible)}** |`,
  `| Seeded bugs wrongly judged as passing | **${wronglyPassed}** |`,
  `| Missed bugs | ${perBug.filter((b) => b.found < b.of).map((b) => `${b.bug} (${b.of - b.found}/${b.of} runs, ${b.missedAsPass ? `${b.missedAsPass} wrongly passed` : "inconclusive"})`).join(", ") || "none"} |`,
  `| **False alarms on the good store** | **${falseAlarms(good).length}**${falseAlarms(good).length ? `: ${falseAlarms(good).join(", ")}` : ""} |`,
  `| False alarms on the buggy store (non-seeded checks failing) | ${falseAlarms(buggy).length}${falseAlarms(buggy).length ? `: ${falseAlarms(buggy).join(", ")}` : ""} |`,
  `| Evidence rate (failures backed by PayPal, store or page evidence) | ${pct(evidenced, allFails.length)} |`,
  `| AI buyer completed its approvals (W1 judgeable) | good: ${pct(buyerDone(good), good.length)}, buggy: ${pct(buyerDone(buggy), buggy.length)} |`,
  `| Median run time (judged runs) | good: ${median(good.map((r) => r.seconds))} s, buggy: ${median(buggy.map((r) => r.seconds))} s |`,
  "",
  "## Per seeded bug",
  "",
  "| Seeded bug | Check(s) that must fail | Detected | Missed as inconclusive | Wrongly passed |",
  "| --- | --- | --- | --- | --- |",
  ...perBug.map((b) => `| ${b.bug} | ${b.checks.join(", ")} | ${pct(b.found, b.of)} | ${b.missedInconclusive} | ${b.missedAsPass} |`),
  "",
  "## Runs",
  "",
  "| Store | Run | Status | Seconds | Failed checks | Inconclusive |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map(
    (r) =>
      `| ${r.store} | \`${r.runId}\` | ${r.status} | ${r.seconds} | ${r.verdicts.filter((v) => v.status === "fail").map((v) => v.check).join(", ") || "—"} | ${r.verdicts.filter((v) => v.status === "inconclusive").map((v) => v.check).join(", ") || "—"} |`,
  ),
  "",
  "## Caveats",
  "",
  "- The buggy store is ours: the same code as the good store with the seeded bugs switched on ([seeded-bugs.md](seeded-bugs.md)). Real stores can fail in other ways.",
  "- A bug counts as detected only if **every** check mapped to it failed with non-recording evidence in that run. A bug is only counted in runs that judged its checks (A4 and A5 were added on Nov 11).",
  "- A missed bug is either **inconclusive** (data was missing, usually because the AI buyer could not approve the test order) or **wrongly passed**. Inconclusive is never turned into a pass.",
  "- C4 (saved methods) is not applicable on both stores. Runs that stopped or failed (a sleeping store failing the ownership check, a manual stop, a crashed cloud browser) are listed above and excluded from the rates.",
  "- Small N.",
  "",
];
writeFileSync(join(findRepoRoot()!, "docs", "benchmark.md"), md.join("\n"));
console.log(`\n${md.slice(4, 18).join("\n")}`);
console.log("\nwrote docs/benchmark.md");
