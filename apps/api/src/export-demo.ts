/**
 * `pnpm demo:export` — snapshot REAL past runs and scorecard trials into
 * apps/api/public/demo-snapshot.json, so the console works without any keys or database
 * (demo mode). It reads through the API's own handlers, so the snapshot matches the live view.
 * Contains sandbox PayPal IDs and redacted run logs only; no secrets, no webhook IDs.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigError, bootConfig, requireConfig } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { buildApi } from "./server.js";

const config = bootConfig("demo:export");
let url: string;
try {
  ({ DATABASE_URL: url } = requireConfig(config, "demo:export", ["DATABASE_URL"]));
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
const db = createPgDb(url);
try {
  await migrateCertifier(db);
  const app = buildApi(config, { repo: certifierRepo(db), logger: false });
  const get = async (path: string) => (await app.inject({ method: "GET", url: path })).json();
  const runs = ((await get("/api/runs")).runs as { id: string; status: string }[]).filter((r) => r.status === "judged").slice(0, 40);
  const runDetails: Record<string, unknown> = {};
  for (const r of runs) runDetails[r.id] = await get(`/api/runs/${r.id}`);
  const snapshot = {
    exportedAt: new Date().toISOString(),
    note: "Recorded real runs from the PayPal sandbox. Demo mode shows these when no live API/database is available.",
    runs,
    runDetails,
    scorecard: await get("/api/scorecard"),
    trials: (await get("/api/trials")).trials,
  };
  const out = fileURLToPath(new URL("../public/demo-snapshot.json", import.meta.url));
  writeFileSync(out, `${JSON.stringify(snapshot, null, 1)}\n`);
  console.log(`demo:export: ${runs.length} judged runs and ${snapshot.trials.length} trials written to apps/api/public/demo-snapshot.json`);
} finally {
  await db.close();
}
