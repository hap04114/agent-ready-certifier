/**
 * `pnpm cert:keygen` — create the Ed25519 key that signs run certificates and write it to .env as
 * CERT_SIGNING_KEY. Prints only the public key ID. Refuses to replace an existing key unless
 * --rotate is given (old certificates stay verifiable only with the old public key).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@certifier/config";
import { generateSigningKey } from "@certifier/trust";

const envPath = join(findRepoRoot()!, ".env");
let text = readFileSync(envPath, "utf8");
const existing = /^CERT_SIGNING_KEY=['"]?([^'"\r\n]+)/m.exec(text)?.[1]?.trim();
if (existing && !process.argv.includes("--rotate")) {
  console.log("cert:keygen: CERT_SIGNING_KEY already set; nothing changed (pass --rotate to replace it)");
  process.exit(0);
}
const key = generateSigningKey();
const line = `CERT_SIGNING_KEY=${key.privateKey}`;
text = /^CERT_SIGNING_KEY=.*$/m.test(text) ? text.replace(/^CERT_SIGNING_KEY=.*$/m, line) : `${text.trimEnd()}\n${line}\n`;
writeFileSync(envPath, text);
console.log(`cert:keygen: wrote CERT_SIGNING_KEY to .env (public key id ${key.publicJwk.kid}). Run pnpm render:sync so the live site can sign.`);
