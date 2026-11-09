/**
 * `pnpm agent:shop [store URL]` — the AI browser agent buys one item on a store it has never
 * seen, in a Kernel cloud browser, and records the journey. Prints the steps, the PayPal order
 * IDs seen in PayPal's own URLs, and where the recording was saved. It does NOT judge the
 * purchase; the truth checker does that from PayPal records.
 *   --approve <PayPal approval link>   only approve an existing order (log in and pay)
 */
import { join } from "node:path";
import { ConfigError, bootConfig, findRepoRoot, redact, requireConfig } from "@certifier/config";
import type { Provider } from "@certifier/llm";
import { runJourney } from "./agent.js";
import { openKernelSession } from "./kernel.js";

const config = bootConfig("agent:shop");
function need() {
  return requireConfig(config, "the browser agent", [
    "KERNEL_API_KEY",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_API_KEY",
    "PAYPAL_SANDBOX_BUYER_EMAIL",
    "PAYPAL_SANDBOX_BUYER_PASSWORD",
  ]);
}
let env: ReturnType<typeof need>;
try {
  env = need();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const args = process.argv.slice(2);
const approveIdx = args.indexOf("--approve");
const approveLink = approveIdx >= 0 ? args[approveIdx + 1] : undefined;
const storeUrl = args.find((a, i) => !a.startsWith("--") && !(approveIdx >= 0 && i === approveIdx + 1)) ?? config.DEMO_STORE_GOOD_URL;
const mission = approveLink
  ? "This is a PayPal sandbox checkout page for an order that already exists. Log in as the buyer and approve or complete the payment. Then reply done."
  : "Buy exactly one unit of any one product on this store and pay with PayPal (log in to the PayPal sandbox account). Reply done once the store shows the payment is complete.";

const session = await openKernelSession(env.KERNEL_API_KEY);
console.log(`Kernel browser ${session.sessionId} started; opening ${approveLink ? "the PayPal approval link" : storeUrl}`);
let exitCode = 0;
try {
  const result = await runJourney({
    context: session.context,
    startUrl: approveLink ?? storeUrl,
    mission,
    llm: { provider: env.LLM_PROVIDER as Provider, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY },
    buyer: { email: env.PAYPAL_SANDBOX_BUYER_EMAIL, password: env.PAYPAL_SANDBOX_BUYER_PASSWORD },
    scrub: (s) => redact(s, config),
    log: console.log,
  });
  console.log(`\nJourney outcome (the agent's own report, not a verdict): ${result.outcome}${result.error ? ` (${result.error})` : ""}`);
  console.log(`PayPal order IDs seen in PayPal URLs: ${result.paypalOrderIds.join(", ") || "none"}`);
  if (result.outcome !== "agent_done") exitCode = 1;
} finally {
  const rec = await session.close(join(findRepoRoot()!, "recordings"));
  console.log(
    // The replay view URL carries a viewing token, so it is kept as evidence but not printed.
    rec ? `Recording: replay ${rec.replayId}${rec.file ? ` saved to ${rec.file}` : ""}` : "Recording: not available",
  );
}
process.exit(exitCode);
