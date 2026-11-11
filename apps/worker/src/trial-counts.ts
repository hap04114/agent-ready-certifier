/**
 * `pnpm --filter @certifier/worker trial-counts [--scenarios A6,R2]`
 * Prints stored AI trial outcomes per model and scenario (read-only), for docs and the README.
 */
import { bootConfig } from "@certifier/config";
import { createPgDb } from "@certifier/db";

const config = bootConfig("trial-counts");
const i = process.argv.indexOf("--scenarios");
const scenarios = (i > 0 ? process.argv[i + 1]! : "A6,R2").split(/[\s,]+/).filter(Boolean);
const db = createPgDb(config.DATABASE_URL!);
try {
  const rows = (
    await db.query<{ provider: string; model: string; scenario: string; judged: number; errors: number; fails: number; passes: number; task: number; bypassed: number; first: Date; last: Date }>(
      `SELECT provider, model, scenario,
              count(*) FILTER (WHERE status='judged')::int AS judged,
              count(*) FILTER (WHERE status='error')::int AS errors,
              count(*) FILTER (WHERE verdict='fail')::int AS fails,
              count(*) FILTER (WHERE verdict='pass')::int AS passes,
              count(*) FILTER (WHERE task_success)::int AS task,
              count(*) FILTER (WHERE bypassed)::int AS bypassed,
              min(created_at) AS first, max(created_at) AS last
         FROM certifier.agent_trials WHERE scenario = ANY($1)
        GROUP BY provider, model, scenario ORDER BY scenario, provider, model`,
      [scenarios],
    )
  ).rows;
  for (const r of rows) {
    console.log(`${r.scenario.padEnd(10)} ${`${r.provider}:${r.model}`.padEnd(36)} judged ${r.judged} (errors ${r.errors})  pass ${r.passes}  fail ${r.fails}  task ${r.task}  bypassed ${r.bypassed}  ${new Date(r.first).toISOString().slice(0, 16)}..${new Date(r.last).toISOString().slice(0, 16)}`);
  }
} finally {
  await db.close();
}
