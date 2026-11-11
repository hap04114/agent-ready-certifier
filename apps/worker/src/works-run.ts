/**
 * `pnpm works:run` — run the Works pillar (W1–W6) against demo-store-good from the command line.
 *   --manual           a human approves the printed links instead of the AI agent
 *   --resume <run id>  reuse an earlier run's approved orders
 * Ctrl+C is the kill switch.
 */
import { ConfigError, bootConfig, requireConfig } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { type Provider, fallbackModelsOf } from "@certifier/llm";
import { RunBudget } from "./budget.js";
import { type StoreName, storeProfile } from "./stores.js";
import { type AgentSettings, runWorksPillar } from "./works.js";

const config = bootConfig("works:run");
const manual = process.argv.includes("--manual");
const resumeIdx = process.argv.indexOf("--resume");
const storeIdx = process.argv.indexOf("--store");
const storeName = (storeIdx > 0 ? process.argv[storeIdx + 1] : "good") as StoreName;

let env: { DATABASE_URL: string };
let agent: AgentSettings | undefined;
try {
  env = requireConfig(config, "works:run", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "DATABASE_URL"]);
  if (!manual) {
    const a = requireConfig(config, "the browser agent (or pass --manual)", [
      "KERNEL_API_KEY",
      "LLM_PROVIDER",
      "LLM_MODEL",
      "LLM_API_KEY",
      "PAYPAL_SANDBOX_BUYER_EMAIL",
      "PAYPAL_SANDBOX_BUYER_PASSWORD",
    ]);
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

const profile = storeProfile(config, storeName);
if ("missing" in profile) {
  console.error(`works:run --store ${storeName} needs: ${profile.missing.join(", ")}`);
  process.exit(1);
}
const budget = new RunBudget(config.RUN_MAX_REQUESTS, config.RUN_MAX_MINUTES);
process.on("SIGINT", () => {
  console.log("\nKill switch: stopping the run.");
  budget.kill();
});

const db = createPgDb(env.DATABASE_URL);
try {
  await migrateCertifier(db);
  const result = await runWorksPillar({
    config,
    repo: certifierRepo(db),
    budget,
    ...profile,
    certifierWebhookUrl: config.WEBHOOK_PUBLIC_URL,
    agent,
    resumeFrom: resumeIdx > 0 ? process.argv[resumeIdx + 1] : undefined,
    log: console.log,
    paypalAudit: (e) =>
      console.log(`  [paypal] ${e.operation} ${e.ok ? "ok" : "FAILED"} ${e.resourceId ?? ""} ${e.resourceStatus ?? ""}${e.requestId ? ` request-id=${e.requestId}` : ""}`),
  });

  console.log(`\n=== Certification — ${storeName} store — run ${result.runId} — ${result.status} — ${budget.used}/${config.RUN_MAX_REQUESTS} requests ===`);
  for (const v of result.verdicts) {
    console.log(`${v.status.toUpperCase().padEnd(12)} ${v.check}  ${v.summary}`);
    for (const r of v.reasons) console.log(`               - ${r}`);
    for (const e of v.evidence) console.log(`               evidence: ${e.kind} ${e.id} [${e.strength}]${e.note ? ` ${e.note}` : ""}`);
  }
  console.log(`\n${result.verdicts.filter((v) => v.status === "pass").length}/${result.verdicts.length} passed`);
  if (result.error) console.error(`run ${result.status}: ${result.error}`);
  process.exitCode = result.status === "judged" ? 0 : 1;
} finally {
  await db.close();
}
