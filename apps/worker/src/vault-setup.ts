/**
 * `pnpm vault:setup` — save the sandbox buyer's PayPal wallet once, for the AI shopper tests.
 * 1. Creates a vault setup token (needs "Save payment methods" enabled on the sandbox app).
 * 2. The AI browser agent approves it as the sandbox buyer in a recorded Kernel browser
 *    (or pass --manual to approve the printed link yourself).
 * 3. Turns it into a payment token and writes PAYPAL_SANDBOX_BUYER_VAULT_ID to .env.
 * Prints IDs of PayPal objects only; never credentials.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openKernelSession, runJourney } from "@certifier/browser-agent";
import { ConfigError, bootConfig, findRepoRoot, redact, requireConfig } from "@certifier/config";
import { type Provider, fallbackModelsOf } from "@certifier/llm";
import { PaypalCallError, SandboxPaypal } from "@certifier/paypal";

const config = bootConfig("vault:setup");
const manual = process.argv.includes("--manual");
const paypal = new SandboxPaypal(config);
const returnUrl = `${config.DEMO_STORE_GOOD_URL.replace(/\/+$/, "")}/`;

let setup: Awaited<ReturnType<typeof paypal.createVaultSetupToken>>;
try {
  setup = await paypal.createVaultSetupToken({ returnUrl, cancelUrl: returnUrl });
} catch (err) {
  if (err instanceof PaypalCallError && err.statusCode === 403) {
    console.error('PayPal refused (403 NOT_AUTHORIZED): turn on "Save payment methods" for the demo-store-good sandbox app, then run this again.');
    console.error("https://developer.paypal.com/dashboard/applications/sandbox → demo-store-good → Features → Save payment methods");
    process.exit(1);
  }
  throw err;
}
if (!setup.approveUrl) {
  console.error(`Setup token ${setup.id} has no approval link (status ${setup.status}).`);
  process.exit(1);
}
console.log(`Setup token ${setup.id} created.`);

if (manual) {
  console.log(`Approve it as the sandbox BUYER: ${setup.approveUrl}\nThen press Enter.`);
  await new Promise((r) => process.stdin.once("data", r));
} else {
  try {
    const a = requireConfig(config, "the browser agent (or pass --manual)", ["KERNEL_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_API_KEY", "PAYPAL_SANDBOX_BUYER_EMAIL", "PAYPAL_SANDBOX_BUYER_PASSWORD"]);
    const session = await openKernelSession(a.KERNEL_API_KEY);
    try {
      const result = await runJourney({
        context: session.context,
        startUrl: setup.approveUrl,
        mission: "This PayPal sandbox page asks the buyer to save PayPal as a payment method for a store. Log in as the buyer if asked, then agree and save. Reply done when PayPal returns you to the store.",
        llm: { provider: a.LLM_PROVIDER as Provider, model: a.LLM_MODEL, apiKey: a.LLM_API_KEY, fallbackModels: fallbackModelsOf(config.LLM_FALLBACK_MODELS) },
        buyer: { email: a.PAYPAL_SANDBOX_BUYER_EMAIL, password: a.PAYPAL_SANDBOX_BUYER_PASSWORD },
        scrub: (t) => redact(t, config),
        maxSteps: 20,
        log: console.log,
      });
      console.log(`Agent finished: ${result.outcome}`);
    } finally {
      const rec = await session.close(join(findRepoRoot()!, "recordings"));
      if (rec) console.log(`Recording: replay ${rec.replayId}`);
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

try {
  const token = await paypal.createVaultPaymentToken(setup.id);
  const envPath = join(findRepoRoot()!, ".env");
  let text = readFileSync(envPath, "utf8");
  const line = `PAYPAL_SANDBOX_BUYER_VAULT_ID='${token.id}'`;
  text = /^PAYPAL_SANDBOX_BUYER_VAULT_ID=.*$/m.test(text) ? text.replace(/^PAYPAL_SANDBOX_BUYER_VAULT_ID=.*$/m, line) : `${text.trimEnd()}\n${line}\n`;
  writeFileSync(envPath, text);
  console.log("Saved wallet ready: wrote PAYPAL_SANDBOX_BUYER_VAULT_ID to .env");
} catch (err) {
  if (err instanceof PaypalCallError) {
    console.error(`Could not create the payment token (${err.message}). Was the setup approved?`);
    process.exit(1);
  }
  throw err;
}
