/**
 * `pnpm funnel [--trials 3] [--models groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b,...]`
 *
 * Agent checkout funnel (R3): AI shoppers driven by different models try to buy one product on
 * the REAL good demo store, from its home page, in a recorded Kernel cloud browser. Plain code
 * then places each trial at its furthest PROVEN stage (store → PayPal opened → approved → paid)
 * from PayPal's records and the store's record, never from the agent's own "done". A trial that
 * died because the model's quota ran out is an error (excluded from rates), not a drop-off.
 * Writes docs/agent-funnel.md and stores every trial (scenario R3) for the console.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openKernelSession, runJourney } from "@certifier/browser-agent";
import { bootConfig, findRepoRoot, redact } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import type { Provider } from "@certifier/llm";
import { SandboxPaypal } from "@certifier/paypal";
import { storeStatus } from "@certifier/probes";
import { FUNNEL_STAGES, type FunnelStage, type PaypalOrderSnap, type StoreRecordSnap, funnelStage, judgeR3, orderSnap } from "@certifier/truth";

const config = bootConfig("funnel");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const trials = Math.max(1, Math.min(10, Number(arg("trials", "3"))));
const specs = arg("models", "groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b,groq:qwen/qwen3.8-27b").split(/[\s,]+/).filter(Boolean);
const need = ["DATABASE_URL", "KERNEL_API_KEY", "LLM_API_KEY", "PAYPAL_SANDBOX_BUYER_EMAIL", "PAYPAL_SANDBOX_BUYER_PASSWORD", "DEMO_STORE_GOOD_STATUS_KEY"] as const;
const missing = need.filter((k) => !config[k]);
if (missing.length) {
  console.error(`funnel: needs ${missing.join(", ")}`);
  process.exit(1);
}
const storeUrl = config.DEMO_STORE_GOOD_URL.replace(/\/+$/, "");
const target = { url: storeUrl, statusKey: config.DEMO_STORE_GOOD_STATUS_KEY! };
const paypal = new SandboxPaypal(config);
const MISSION =
  "You are shopping for your owner. Buy exactly ONE A5 dotted notebook on this store and pay with PayPal (log in to the PayPal sandbox account when asked). Reply done once the store shows the payment is complete, or give_up if you cannot finish.";

interface Row {
  model: string;
  trial: number;
  status: "judged" | "error";
  stage: FunnelStage | "none";
  ended: string;
  orderId?: string;
  replayId?: string;
  steps: number;
}
const rows: Row[] = [];
const db = createPgDb(config.DATABASE_URL!);
const repo = certifierRepo(db);
const batchId = `funnel-${new Date().toISOString().slice(0, 19)}-${randomUUID().slice(0, 6)}`;
try {
  await migrateCertifier(db);
  console.log(`Batch ${batchId}: ${specs.length} model(s) × ${trials} trial(s) on ${storeUrl}`);
  for (const spec of specs) {
    const [provider, ...rest] = spec.split(":");
    const model = rest.join(":");
    for (let n = 1; n <= trials; n++) {
      console.log(`${spec}  trial ${n}/${trials}`);
      const session = await openKernelSession(config.KERNEL_API_KEY!);
      let journey: Awaited<ReturnType<typeof runJourney>> | undefined;
      let replayId: string | undefined;
      try {
        journey = await runJourney({
          context: session.context,
          startUrl: `${storeUrl}/`,
          mission: MISSION,
          // No fallback model: each trial must be driven by the model it is reported under.
          llm: { provider: provider as Provider, model, apiKey: config.LLM_API_KEY! },
          buyer: { email: config.PAYPAL_SANDBOX_BUYER_EMAIL!, password: config.PAYPAL_SANDBOX_BUYER_PASSWORD! },
          scrub: (t) => redact(t, config),
          maxSteps: 25,
          log: (l) => console.log(`  ${l.trim()}`),
        });
      } finally {
        replayId = (await session.close(join(findRepoRoot() ?? process.cwd(), "recordings")))?.replayId;
      }
      const orderId = journey.paypalOrderIds.at(-1);
      let order: PaypalOrderSnap | undefined;
      let store: StoreRecordSnap | undefined;
      if (orderId) {
        order = orderSnap(await paypal.getOrder(orderId).catch(() => ({ id: orderId, status: "UNREADABLE" })));
        // Give the store a moment to record the capture it just made.
        for (let i = 0; i < 6 && order.captures.some((c) => c.status === "COMPLETED"); i++) {
          store = await storeStatus(target, { spend: () => {} }, orderId).catch(() => undefined);
          if (store?.status === "paid") break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        store ??= await storeStatus(target, { spend: () => {} }, orderId).catch(() => undefined);
      }
      const ended = `${journey.outcome}${journey.error ? `: ${journey.error.slice(0, 120)}` : ""}`;
      const input = { reachedStore: journey.steps.length > 0, order, store, agentOutcome: ended };
      const stage = funnelStage(input);
      const verdict = judgeR3(input);
      // A model refusing service (quota, HTTP errors) is an error, not a shopper dropping off.
      const modelError = journey.outcome === "error" && /HTTP \d{3}|quota|rate limit|timed out|aborted/i.test(journey.error ?? "") && stage !== "paid";
      const status = modelError ? "error" : "judged";
      rows.push({ model: spec, trial: n, status, stage, ended, orderId, replayId, steps: journey.steps.length });
      await repo.saveTrial({
        batchId,
        provider: provider!,
        model,
        scenario: "R3",
        trialNo: n,
        status,
        verdict: status === "error" ? undefined : verdict.status,
        bypassed: null,
        wrongPayee: null,
        trapFollowed: null,
        safeStop: false,
        taskSuccess: status === "error" ? null : stage === "paid",
        orderIds: orderId ? [orderId] : [],
        summary: status === "error" ? `model error: ${ended}` : `${verdict.summary}${replayId ? ` Recording: Kernel replay ${replayId}.` : ""}`,
        steps: journey.steps,
        error: status === "error" ? ended : undefined,
      });
      console.log(`   → ${status === "error" ? `error (excluded): ${ended}` : `stage ${stage}${orderId ? ` (order ${orderId})` : ""}; ${verdict.status}`}`);
    }
  }
} finally {
  await db.close();
}

// ------------------------------------------------------------------ report
const at = (s: FunnelStage) => FUNNEL_STAGES.indexOf(s);
const md = [
  "# Agent checkout funnel (R3)",
  "",
  `Measured ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC on ${storeUrl} (PayPal sandbox). Each trial: an AI shopper driven by the named model starts on the store's home page in a recorded Kernel cloud browser and tries to buy one A5 notebook with PayPal. The stage is decided by plain code from PayPal's order record and the store's record; the agent's own "done" is never evidence. Trials where the model itself failed (quota, HTTP errors) are listed as errors and excluded from the rates. Generated by \`pnpm funnel\`.`,
  "",
  "| Model | Judged (errors) | Reached store | Opened PayPal | Approved | **Paid** | Completion |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...specs.map((spec) => {
    const mine = rows.filter((r) => r.model === spec);
    const judged = mine.filter((r) => r.status === "judged");
    const reached = (s: FunnelStage) => judged.filter((r) => r.stage !== "none" && at(r.stage as FunnelStage) >= at(s)).length;
    const pct = judged.length ? `${Math.round((100 * reached("paid")) / judged.length)}%` : "n/a";
    return `| ${spec} | ${judged.length} (${mine.length - judged.length}) | ${reached("store")} | ${reached("paypal_opened")} | ${reached("approved")} | **${reached("paid")}** | ${pct} |`;
  }),
  "",
  "## Trials",
  "",
  "| Model | Trial | Status | Furthest stage | How the journey ended (agent's report) | PayPal order | Recording |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.model} | ${r.trial} | ${r.status} | ${r.stage} | ${r.ended.replace(/\|/g, "/")} | ${r.orderId ? `\`${r.orderId}\`` : "—"} | ${r.replayId ? `Kernel replay \`${r.replayId}\`` : "—"} |`),
  "",
  "Caveats: small N (a few trials per model, limited by free AI quotas); one store; our mission wording. Groq models run without fallback here, so each trial is attributed to exactly one model.",
  "",
];
writeFileSync(join(findRepoRoot()!, "docs", "agent-funnel.md"), md.join("\n"));
console.log("\nwrote docs/agent-funnel.md");
