/**
 * `pnpm store:keys` — prepare the demo store's private status key in the local .env.
 * - Generates OWNERSHIP_TOKEN_SECRET (48 random bytes) if it is empty.
 * - Generates CERTIFIER_ADMIN_TOKEN if it is empty.
 * - Derives DEMO_STORE_GOOD_STATUS_KEY (private) and DEMO_STORE_GOOD_OWNERSHIP_TOKEN (public) for DEMO_STORE_GOOD_URL.
 * Writes .env in place and never prints either value.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, loadConfig } from "@certifier/config";
import { deriveOwnershipToken, deriveStatusKey } from "./index.js";

const root = findRepoRoot();
const envPath = root && join(root, ".env");
if (!envPath || !existsSync(envPath)) {
  console.error("store:keys: no .env file (copy .env.example to .env first)");
  process.exit(1);
}

function setVar(text: string, key: string, value: string): string {
  const line = `${key}='${value}'`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}

let text = readFileSync(envPath, "utf8");
let config = loadConfig();
if (!config.OWNERSHIP_TOKEN_SECRET) {
  text = setVar(text, "OWNERSHIP_TOKEN_SECRET", randomBytes(48).toString("base64url"));
  writeFileSync(envPath, text);
  config = loadConfig();
  console.log("store:keys: generated OWNERSHIP_TOKEN_SECRET");
}
if (!config.CERTIFIER_ADMIN_TOKEN) {
  text = setVar(text, "CERTIFIER_ADMIN_TOKEN", randomBytes(32).toString("base64url"));
  console.log("store:keys: generated CERTIFIER_ADMIN_TOKEN");
}
text = setVar(text, "DEMO_STORE_GOOD_STATUS_KEY", deriveStatusKey(config.OWNERSHIP_TOKEN_SECRET!, config.DEMO_STORE_GOOD_URL));
text = setVar(text, "DEMO_STORE_GOOD_OWNERSHIP_TOKEN", deriveOwnershipToken(config.OWNERSHIP_TOKEN_SECRET!, config.DEMO_STORE_GOOD_URL));
text = setVar(text, "DEMO_STORE_BUGGY_STATUS_KEY", deriveStatusKey(config.OWNERSHIP_TOKEN_SECRET!, config.DEMO_STORE_BUGGY_URL));
text = setVar(text, "DEMO_STORE_BUGGY_OWNERSHIP_TOKEN", deriveOwnershipToken(config.OWNERSHIP_TOKEN_SECRET!, config.DEMO_STORE_BUGGY_URL));
writeFileSync(envPath, text);
console.log(`store:keys: wrote DEMO_STORE_GOOD_STATUS_KEY and DEMO_STORE_GOOD_OWNERSHIP_TOKEN for ${new URL(config.DEMO_STORE_GOOD_URL).origin}`);
console.log(`store:keys: wrote DEMO_STORE_BUGGY_STATUS_KEY and DEMO_STORE_BUGGY_OWNERSHIP_TOKEN for ${new URL(config.DEMO_STORE_BUGGY_URL).origin}`);
