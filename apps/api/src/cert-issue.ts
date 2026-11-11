/**
 * `pnpm cert:issue <run id> [<run id> ...]` — issue signed certificates for judged runs (the same
 * logic as GET /api/runs/:id/certificate), append them to the hash log and timestamp each entry
 * hash with OpenTimestamps unless FEATURE_OPENTIMESTAMPS=off. Prints IDs and hashes only.
 */
import { bootConfig } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { ensureCertificate } from "./trust-routes.js";

const config = bootConfig("cert:issue");
const ids = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/i.test(a));
if (!ids.length || !config.DATABASE_URL) {
  console.error("usage: pnpm cert:issue <run id> [...]   (needs DATABASE_URL and CERT_SIGNING_KEY)");
  process.exit(2);
}
const db = createPgDb(config.DATABASE_URL);
const repo = certifierRepo(db);
try {
  await migrateCertifier(db);
  for (const id of ids) {
    const r = await ensureCertificate({ config, repo }, id);
    const entry = r.ok ? await repo.getLogEntryForRun(id) : undefined;
    console.log(r.ok ? `${id}: certificate issued; hash log #${entry?.seq} ${entry?.entry_hash}${entry?.has_ots ? " (OpenTimestamps submitted)" : ""}` : `${id}: ${r.error}`);
  }
} finally {
  await db.close();
}
