/**
 * `pnpm env:copy <KEY>` — copy one value from .env to the clipboard (Windows `clip`), so it can
 * be pasted into a hosting dashboard without being printed or retyped. Prints only the name.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { envSchema, findRepoRoot } from "./env.js";

const key = process.argv[2];
const known = Object.keys(envSchema.shape);
if (!key || !known.includes(key)) {
  console.error(`usage: pnpm env:copy <KEY>   (one of the variables in .env.example)`);
  process.exit(2);
}
const value = parse(readFileSync(join(findRepoRoot()!, ".env")))[key]?.trim();
if (!value) {
  console.error(`env:copy: ${key} is empty in .env`);
  process.exit(1);
}
try {
  execFileSync("clip", { input: value });
  console.log(`env:copy: ${key} copied to the clipboard. Paste it with Ctrl+V.`);
} catch {
  console.error("env:copy: clipboard not available on this system");
  process.exit(1);
}
