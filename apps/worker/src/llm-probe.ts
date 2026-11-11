/**
 * `pnpm --filter @certifier/worker llm:probe groq:openai/gpt-oss-120b [groq:qwen/qwen3.8-27b ...]`
 *
 * One tiny JSON call per model to see whether it is answering right now (free tiers have daily
 * quotas). Exit code 0: every model answered; 2: at least one is out of quota; 1: other error.
 * Used before unattended trial batches so quota failures are not recorded as trials.
 */
import { bootConfig } from "@certifier/config";
import { LlmError, type Provider, askJson } from "@certifier/llm";
import { z } from "zod";

const config = bootConfig("llm:probe");
const specs = process.argv.slice(2).flatMap((a) => a.split(/[\s,]+/)).filter((a) => a.includes(":"));
let code = 0;
for (const spec of specs) {
  const [provider, ...rest] = spec.split(":");
  const model = rest.join(":");
  const apiKey = provider === "gemini" ? config.GEMINI_API_KEY : config.LLM_API_KEY;
  try {
    await askJson({ provider: provider as Provider, model, apiKey: apiKey ?? "" }, [{ role: "user", content: 'Reply with {"ok": true}' }], z.object({ ok: z.boolean() }));
    console.log(`${spec}: available`);
  } catch (err) {
    const quota = err instanceof LlmError && (err.dailyQuota || err.status === 429);
    console.log(`${spec}: ${quota ? "out of quota" : "error"} (${err instanceof Error ? err.message.slice(0, 120) : "unknown"})`);
    code = Math.max(code, quota ? 2 : 1);
  }
}
process.exit(code);
