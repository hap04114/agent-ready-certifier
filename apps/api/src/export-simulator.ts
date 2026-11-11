/**
 * `pnpm --filter @certifier/api simulator:export`
 *
 * Writes public/simulator-data.json for the /simulator page from REAL recorded results only:
 * - the 21 verdicts of the correct store's run and of the buggy store's run (with evidence);
 * - the planted-bug answer key (which checks each bug must fail);
 * - every AI-shopper cell (model × scenario) with its actual N and rates, plus one failing and
 *   one passing recorded trial (steps, verdict, PayPal order IDs) for replay.
 * The page only recombines these recorded results; it never runs or invents anything.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigError, bootConfig, requireConfig } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { buildApi } from "./server.js";

const GOOD_RUN = "ed37cc30-8e31-4872-b753-4957b62709a3";
const BUGGY_RUN = "9d2bdcbd-25de-4da9-97b1-4013ede178a0";
const BUGS = [
  { id: "trust_client_price", name: "The server trusts the price the browser sends", effect: "anyone can buy a $64 item for $1", checks: ["S1"] },
  { id: "refund_webhook_broken", name: "The refund notification handler is broken", effect: "PayPal refunds, the store still says paid", checks: ["W4"] },
  { id: "accept_unsigned_webhooks", name: "Unsigned notifications are accepted", effect: "a forged message can mark an order paid", checks: ["S2"] },
  { id: "no_webhook_dedup", name: "No duplicate protection for notifications", effect: "one payment can be processed twice", checks: ["S3", "W6"] },
  { id: "expose_client_secret", name: "The client secret is in a public script", effect: "anyone can act as the merchant's PayPal app", checks: ["S5"] },
  { id: "no_request_id_on_retry", name: "No PayPal-Request-Id on retries", effect: "a network retry creates a second order", checks: ["S7"] },
  { id: "no_security_headers", name: "No CSP or HSTS security headers", effect: "the checkout page is easier to tamper with", checks: ["S8"] },
  { id: "no_pay_later", name: "No Pay Later messaging", effect: "the store misses PayPal's growth playbook", checks: ["C2"] },
  { id: "agent_price_mismatch", name: "Stale machine-readable price (JSON-LD)", effect: "AI agents see a different price than PayPal charges", checks: ["A4"] },
  { id: "unlabeled_controls", name: "Unlabeled product picker and quantity box", effect: "AI agents can't tell what the controls do", checks: ["A5"] },
];
const SCENARIOS = ["R1", "A1", "A2-inbox", "A2-paypal", "A2-passkey", "A3"];

const config = bootConfig("simulator:export");
let databaseUrl: string;
try {
  ({ DATABASE_URL: databaseUrl } = requireConfig(config, "simulator:export", ["DATABASE_URL"]));
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
const db = createPgDb(databaseUrl);
try {
  await migrateCertifier(db);
  const repo = certifierRepo(db);
  const app = buildApi(config, { repo, logger: false });
  const runOf = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/api/runs/${id}` });
    if (res.statusCode !== 200) throw new Error(`run ${id}: HTTP ${res.statusCode}`);
    const r = res.json() as { id: string; store_url: string; checks: { code: string; pillar: string; status: string; summary: string; reasons: string[]; evidence: unknown[]; businessImpact: string | null }[] };
    return {
      id: r.id,
      storeUrl: r.store_url,
      checks: Object.fromEntries(r.checks.map((c) => [c.code, { pillar: c.pillar, status: c.status, summary: c.summary, reasons: c.reasons, evidence: c.evidence, businessImpact: c.businessImpact }])),
    };
  };
  const good = await runOf(GOOD_RUN);
  const buggy = await runOf(BUGGY_RUN);

  const trials = (await repo.listTrials(5000)) as unknown as {
    id: string; provider: string; model: string; scenario: string; status: string; verdict: string | null; bypassed: boolean | null;
    wrong_payee: boolean | null; trap_followed: boolean | null; safe_stop: boolean; task_success: boolean | null; order_ids: string[]; summary: string | null; created_at: string;
  }[];
  const cells: Record<string, unknown> = {};
  const rate = (xs: (boolean | null)[]) => {
    const j = xs.filter((x) => x !== null);
    return j.length ? { k: j.filter(Boolean).length, n: j.length } : null;
  };
  for (const t of trials) {
    if (!SCENARIOS.includes(t.scenario)) continue;
    const key = `${t.provider}:${t.model}|${t.scenario}`;
    if (cells[key]) continue;
    const mine = trials.filter((x) => `${x.provider}:${x.model}` === `${t.provider}:${t.model}` && x.scenario === t.scenario);
    const judged = mine.filter((x) => x.status === "judged");
    if (judged.length === 0) continue;
    const pick = async (x: (typeof judged)[number] | undefined) =>
      x ? { id: x.id, verdict: x.verdict, summary: x.summary, orderIds: x.order_ids, at: x.created_at, steps: (await repo.getTrialSteps(x.id)) ?? [] } : null;
    cells[key] = {
      agent: `${t.provider}:${t.model}`,
      scenario: t.scenario,
      n: judged.length,
      errors: mine.length - judged.length,
      bypass: rate(judged.map((x) => x.bypassed)),
      trapFollowed: rate(judged.map((x) => x.trap_followed)),
      wrongPayee: rate(judged.map((x) => x.wrong_payee)),
      askedOwner: rate(judged.map((x) => x.safe_stop)),
      taskSuccess: rate(judged.map((x) => x.task_success)),
      failing: await pick(judged.find((x) => x.verdict === "fail")),
      passing: await pick(judged.find((x) => x.verdict === "pass" && /approved with a passkey/.test(x.summary ?? "")) ?? judged.find((x) => x.verdict === "pass")),
    };
  }
  const out = {
    exportedAt: new Date().toISOString(),
    note: "Recorded results from real PayPal sandbox runs and trials. The simulator only recombines them; it never runs or invents anything.",
    runs: { good, buggy },
    bugs: BUGS,
    cells,
  };
  const file = fileURLToPath(new URL("../public/simulator-data.json", import.meta.url));
  writeFileSync(file, `${JSON.stringify(out)}\n`);
  console.log(`simulator:export: 2 runs, ${BUGS.length} bugs, ${Object.keys(cells).length} AI-shopper cells → public/simulator-data.json`);
} finally {
  await db.close();
}
