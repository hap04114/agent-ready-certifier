/**
 * `pnpm webhooks:ensure <https URL> <ENV KEY>`
 * Makes sure the PayPal sandbox app has a webhook for URL (creating it if needed) with the
 * payment events the certifier uses, then writes its ID into .env under ENV KEY and copies it
 * to the clipboard (Windows) for pasting into Render. The ID is never printed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootConfig, findRepoRoot } from "@certifier/config";
import { SandboxPaypal } from "@certifier/paypal";

const EVENTS = ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.PENDING"];
const ALLOWED_KEYS = ["PAYPAL_WEBHOOK_ID", "DEMO_STORE_GOOD_WEBHOOK_ID", "DEMO_STORE_BUGGY_WEBHOOK_ID", "DEMO_STORE_BUGGY_CERTIFIER_WEBHOOK_ID"];

const [url, key] = process.argv.slice(2);
if (!url || !key || !url.startsWith("https://") || !ALLOWED_KEYS.includes(key)) {
  console.error(`usage: pnpm webhooks:ensure <https URL> <${ALLOWED_KEYS.join(" | ")}>`);
  process.exit(2);
}
const config = bootConfig("webhooks:ensure");
// Webhooks for the buggy store live on ITS OWN sandbox app.
const buggy = key.startsWith("DEMO_STORE_BUGGY_");
if (buggy && (!config.DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID || !config.DEMO_STORE_BUGGY_PAYPAL_CLIENT_SECRET)) {
  console.error("webhooks:ensure: DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID and _SECRET are needed for the buggy store's app");
  process.exit(1);
}
const paypal = new SandboxPaypal(
  buggy ? { ...config, PAYPAL_CLIENT_ID: config.DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: config.DEMO_STORE_BUGGY_PAYPAL_CLIENT_SECRET } : config,
);
const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
const existing = (await paypal.listWebhooks()).find((h) => norm(h.url) === norm(url));
const id = existing?.id ?? (await paypal.createWebhook(url, EVENTS)).id;
console.log(existing ? `webhooks:ensure: a webhook for ${url} already exists` : `webhooks:ensure: created a webhook for ${url}`);

const envPath = join(findRepoRoot()!, ".env");
let text = readFileSync(envPath, "utf8");
const re = new RegExp(`^${key}=.*$`, "m");
text = re.test(text) ? text.replace(re, `${key}='${id}'`) : `${text.trimEnd()}\n${key}='${id}'\n`;
writeFileSync(envPath, text);
console.log(`webhooks:ensure: wrote ${key} to .env`);
try {
  execFileSync("clip", { input: id });
  console.log(`webhooks:ensure: copied ${key} to the clipboard`);
} catch {
  console.log(`webhooks:ensure: clipboard not available; copy ${key} from .env`);
}
