/**
 * `pnpm webhooks:sync <store webhook URL> <certifier webhook URL>`
 * Looks up the demo-store-good app's webhook subscriptions in PayPal and writes the matching
 * IDs into .env as DEMO_STORE_GOOD_WEBHOOK_ID and PAYPAL_WEBHOOK_ID. Prints only which
 * variables were written, never values.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootConfig, findRepoRoot } from "@certifier/config";
import { SandboxPaypal } from "@certifier/paypal";

const [storeUrl, certifierUrl] = process.argv.slice(2);
if (!storeUrl || !certifierUrl) {
  console.error("usage: pnpm webhooks:sync <store webhook URL> <certifier webhook URL>");
  process.exit(2);
}
const config = bootConfig("webhooks:sync");
const hooks = await new SandboxPaypal(config).listWebhooks();
const norm = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
const find = (u: string) => hooks.find((h) => norm(h.url) === norm(u))?.id;

const envPath = join(findRepoRoot()!, ".env");
let text = readFileSync(envPath, "utf8");
const set = (key: string, value: string) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, `${key}='${value}'`) : `${text.trimEnd()}\n${key}='${value}'\n`;
};
let missing = 0;
for (const [key, url] of [["DEMO_STORE_GOOD_WEBHOOK_ID", storeUrl], ["PAYPAL_WEBHOOK_ID", certifierUrl]] as const) {
  const id = find(url);
  if (id) {
    set(key, id);
    console.log(`webhooks:sync: wrote ${key}`);
  } else {
    missing++;
    console.error(`webhooks:sync: no webhook registered for ${url}`);
  }
}
writeFileSync(envPath, text);
console.log(`webhooks:sync: the app has ${hooks.length} webhook(s) registered`);
process.exitCode = missing ? 1 : 0;
