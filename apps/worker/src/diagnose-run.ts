/**
 * `pnpm diagnose <run id>` — the diagnosis agent explains every FAILED check of a run and
 * suggests a fix, grounded in PayPal Server SDK context from APIMatic ContextMatic (when
 * registered: pnpm apimatic:register). Findings are stored next to the verdicts; the verdicts
 * themselves are never changed.
 */
import { ConfigError, bootConfig, requireConfig } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { type ContextMaticSession, FIX_TOPICS, askContextMatic, diagnose, openContextMatic } from "@certifier/diagnosis";
import type { Provider } from "@certifier/llm";
import { impactOf } from "@certifier/truth";

const config = bootConfig("diagnose");
const runId = process.argv[2];
if (!runId) {
  console.error("usage: pnpm diagnose <run id>");
  process.exit(2);
}
let env: { DATABASE_URL: string; LLM_PROVIDER: string; LLM_MODEL: string; LLM_API_KEY: string };
try {
  env = requireConfig(config, "the diagnosis agent", ["DATABASE_URL", "LLM_PROVIDER", "LLM_MODEL", "LLM_API_KEY"]);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
const db = createPgDb(env.DATABASE_URL);
const repo = certifierRepo(db);
let session: ContextMaticSession | undefined;
try {
  await migrateCertifier(db);
  const run = await repo.getRun(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const failed = run.checks.filter((c) => c.status === "fail");
  console.log(`Run ${runId}: ${failed.length} failed check(s)`);
  if (failed.length === 0) process.exit(0);

  if (config.APIMATIC_CLIENT_ID) {
    try {
      session = await openContextMatic({ clientId: config.APIMATIC_CLIENT_ID, clientSecret: config.APIMATIC_CLIENT_SECRET, mcpUrl: config.APIMATIC_CONTEXT_MCP_URL });
      console.log(`ContextMatic connected (tools: ${session.tools.join(", ")})`);
    } catch (err) {
      console.warn(`ContextMatic unavailable (${err instanceof Error ? err.message : "error"}); findings will be marked "no SDK context".`);
    }
  } else {
    console.warn('ContextMatic not registered (run pnpm apimatic:register); findings will be marked "no SDK context".');
  }

  const llm = { provider: env.LLM_PROVIDER as Provider, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY };
  for (const c of failed) {
    const topic = FIX_TOPICS[c.code];
    const context = session && topic ? await askContextMatic(session, topic).catch(() => undefined) : undefined;
    const d = await diagnose({ llm, code: c.code, summary: c.summary, reasons: c.reasons, businessImpact: impactOf(c.code), context });
    await repo.saveFinding({
      runId,
      code: c.code,
      explanation: d.explanation,
      fixSteps: d.fixSteps,
      codeSnippet: d.codeSnippet,
      verified: d.verifiedSdkMethods,
      unverified: d.unverifiedSdkMethods,
      source: d.source,
      model: `${llm.provider}:${llm.model}`,
    });
    console.log(`  ${c.code}: ${d.source === "contextmatic" ? `grounded via ContextMatic ${d.contextTool}` : "no SDK context"}; SDK methods verified: ${d.verifiedSdkMethods.join(", ") || "none"}${d.unverifiedSdkMethods.length ? `; unverified: ${d.unverifiedSdkMethods.join(", ")}` : ""}`);
  }
} finally {
  await session?.close().catch(() => {});
  await db.close();
}
