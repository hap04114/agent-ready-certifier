/**
 * `pnpm scan:env-values` — fail if any sensitive value from the local .env appears in a
 * file git tracks or has staged. Complements gitleaks, which only knows secret *patterns*.
 * Prints variable names and file paths only, never values.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { SENSITIVE_KEYS, findRepoRoot } from "./env.js";

const root = findRepoRoot();
if (!root) throw new Error("repo root not found");
const envPath = join(root, ".env");
if (!existsSync(envPath)) {
  console.log("scan:env-values: no .env file, nothing to compare");
  process.exit(0);
}
const env = parse(readFileSync(envPath));
let found = 0;
for (const key of SENSITIVE_KEYS) {
  const value = env[key]?.trim();
  if (!value || value.length < 6) continue;
  // Skip template placeholders that are meant to be public (e.g. the example DATABASE_URL).
  if (readFileSync(join(root, ".env.example"), "utf8").includes(value)) continue;
  try {
    const files = execFileSync("git", ["grep", "--cached", "-l", "-F", "-e", value], { cwd: root, encoding: "utf8" }).trim();
    if (files) {
      found++;
      console.error(`LEAK: value of ${key} appears in: ${files.split("\n").join(", ")}`);
    }
  } catch (err) {
    // git grep exits 1 when nothing matches.
    if ((err as { status?: number }).status !== 1) throw err;
  }
}
if (found) process.exit(1);
console.log("scan:env-values: no .env values found in tracked or staged files");
