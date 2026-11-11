/**
 * `pnpm benchmark [--runs 5] [--stores good,buggy]` — measure the certifier's accuracy against
 * the seeded-bug answer key (docs/seeded-bugs.md) and write docs/benchmark.md.
 * Metrics: detection rate (seeded bugs whose check failed with evidence), missed bugs, false
 * alarms (failed checks that are not seeded), evidence rate and median run time.
 * Every number comes from real sandbox runs stored in the evidence database; nothing is invented.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, bootConfig, findRepoRoot, requireConfig } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import type { Provider } from "@certifier/llm";
import type { Verdict } from "@certifier/truth";
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
};
const SEEDED_CHECKS = new Set(Object.values(ANSWER_KEY).flat());

const config = bootConfig("benchmark");
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
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
  ({ DATABASE_URL: dbUrl } = requireConfig(config, "benchmark", ["DATABASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]));
  const a = requireConfig(config, "the browser agent", ["KERNEL_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_API_KEY", "PAYPAL_SANDBOX_BUYER_EMAIL", "PAYPAL_SANDBOX_BUYER_PASSWORD"]);
  agent = {
    kernelApiKey: a.KERNEL_API_KEY,
    llm: { provider: a.LLM_PROVIDER as Provider, model: a.LLM_MODEL, apiKey: a.LLM_API_KEY },
    buyer: { email: a.PAYPAL_SANDBOX_BUYER_EMAIL, password: a.PAYPAL_SANDBOX_BUYER_PASSWORD },
  };
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

const perBug = Object.entries(ANSWER_KEY).map(([bug, checks]) => {
  const found = buggy.filter((r) => checks.every((c) => r.verdicts.some((v) => v.check === c && v.status === "fail" && strongEvidence(v)))).length;
  return { bug, checks, found, of: buggy.length };
});
const detections = perBug.reduce((s, b) => s + b.found, 0);
const possible = perBug.length * buggy.length;
const falseAlarms = (rs: Row[]) => rs.flatMap((r) => r.verdicts.filter((v) => v.status === "fail" && (r.store === "good" || !SEEDED_CHECKS.has(v.check))).map((v) => `${v.check} (run ${r.runId.slice(0, 8)})`));
const allFails = judged.flatMap((r) => r.verdicts.filter((v) => v.status === "fail"));
const evidenced = allFails.filter(strongEvidence).length;

const pct = (k: number, n: number) => (n === 0 ? "n/a" : `${k}/${n} (${Math.round((100 * k) / n)}%)`);
const md = [
  "# Benchmark: certifier accuracy on seeded bugs",
  "",
  `Measured ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC on the hosted demo stores (PayPal sandbox), with the AI buyer agent approving every order in a Kernel cloud browser. Generated by \`pnpm benchmark\`; every number below comes from these runs.`,
  "",
  "## Summary",
  "",
  "| Metric | Result |",
  "| --- | --- |",
  `| Runs judged | good store: ${good.length}, buggy store: ${buggy.length} (of ${rows.length} started) |`,
  `| **Detection rate** (seeded bug's check failed, with evidence) | **${pct(detections, possible)}** |`,
  `| Missed bugs | ${perBug.filter((b) => b.found < b.of).map((b) => `${b.bug} (${b.of - b.found}/${b.of} runs)`).join(", ") || "none"} |`,
  `| **False alarms on the good store** | **${falseAlarms(good).length}**${falseAlarms(good).length ? `: ${falseAlarms(good).join(", ")}` : ""} |`,
  `| False alarms on the buggy store (non-seeded checks failing) | ${falseAlarms(buggy).length}${falseAlarms(buggy).length ? `: ${falseAlarms(buggy).join(", ")}` : ""} |`,
  `| Evidence rate (failures backed by PayPal, store or page evidence) | ${pct(evidenced, allFails.length)} |`,
  `| Median run time | good: ${median(good.map((r) => r.seconds))} s, buggy: ${median(buggy.map((r) => r.seconds))} s |`,
  "",
  "## Per seeded bug",
  "",
  "| Seeded bug | Check(s) that must fail | Detected |",
  "| --- | --- | --- |",
  ...perBug.map((b) => `| ${b.bug} | ${b.checks.join(", ")} | ${pct(b.found, b.of)} |`),
  "",
  "## Runs",
  "",
  "| Store | Run | Status | Seconds | Failed checks |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.store} | \`${r.runId}\` | ${r.status} | ${r.seconds} | ${r.verdicts.filter((v) => v.status === "fail").map((v) => v.check).join(", ") || "—"} |`),
  "",
  "## Caveats",
  "",
  "- The buggy store is ours: the same code as the good store with eight bugs switched on ([seeded-bugs.md](seeded-bugs.md)). Real stores can fail in other ways.",
  "- A bug counts as detected only if **every** check mapped to it failed with non-recording evidence in that run.",
  "- C4 (saved methods) is reported as not applicable on both stores and is not part of this benchmark.",
  "- Small N. Runs that stopped or failed are listed above and excluded from the rates.",
  "",
];
writeFileSync(join(findRepoRoot()!, "docs", "benchmark.md"), md.join("\n"));
console.log("\n" + md.slice(4, 16).join("\n"));
console.log("\nwrote docs/benchmark.md");
