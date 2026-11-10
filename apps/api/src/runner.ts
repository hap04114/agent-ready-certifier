/**
 * In-process worker (Milestone 4, deliberately minimal): runs the Works pillar in the API
 * process. One run at a time is enforced by the Run API. A queue can replace this later.
 */
import type { Config } from "@certifier/config";
import type { CertifierRepo } from "@certifier/db";
import type { Provider } from "@certifier/llm";
import { RunBudget } from "@certifier/worker/budget";
import { type AgentSettings, runWorksPillar } from "@certifier/worker/works";
import type { RunStarter } from "./runs.js";

/** Agent settings, when every variable the browser agent needs is configured. */
export function agentFromConfig(config: Config): AgentSettings | undefined {
  const c = config;
  if (!c.KERNEL_API_KEY || !c.LLM_PROVIDER || !c.LLM_MODEL || !c.LLM_API_KEY || !c.PAYPAL_SANDBOX_BUYER_EMAIL || !c.PAYPAL_SANDBOX_BUYER_PASSWORD) return undefined;
  return {
    kernelApiKey: c.KERNEL_API_KEY,
    llm: { provider: c.LLM_PROVIDER as Provider, model: c.LLM_MODEL, apiKey: c.LLM_API_KEY },
    buyer: { email: c.PAYPAL_SANDBOX_BUYER_EMAIL, password: c.PAYPAL_SANDBOX_BUYER_PASSWORD },
  };
}

export function makeRunner(config: Config, repo: CertifierRepo): RunStarter {
  return {
    start({ runId, store }) {
      const budget = new RunBudget(config.RUN_MAX_REQUESTS, config.RUN_MAX_MINUTES);
      void (async () => {
        await repo.setRunStatus(runId, "running");
        const result = await runWorksPillar({
          config,
          repo,
          budget,
          runId,
          store,
          certifierWebhookUrl: config.WEBHOOK_PUBLIC_URL,
          agent: agentFromConfig(config),
          log: (line) => console.log(`[run ${runId.slice(0, 8)}] ${line}`),
        });
        console.log(`[run ${runId.slice(0, 8)}] finished: ${result.status}${result.error ? ` (${result.error})` : ""}`);
      })().catch(async (err: unknown) => {
        await repo.finishRun(runId, "failed", budget.used, { error: err instanceof Error ? err.name : "unknown" }).catch(() => {});
      });
      return { kill: () => budget.kill() };
    },
  };
}
