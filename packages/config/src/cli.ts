/**
 * `pnpm check:env` — validate the environment and print which variables are set.
 * Sensitive values are shown only as "set" / "not set".
 */
import { bootConfig, describeConfig } from "./index.js";

const config = bootConfig("check:env");
const rows = describeConfig(config);
const width = Math.max(...Object.keys(rows).map((k) => k.length));
for (const [key, value] of Object.entries(rows)) console.log(`${key.padEnd(width)}  ${value}`);
