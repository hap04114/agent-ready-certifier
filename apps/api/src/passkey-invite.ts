/**
 * `pnpm passkey:invite [--print]`
 *
 * Creates a one-time link (valid 15 minutes, single use) to register the owner's passkey on the
 * certifier's /owner page, and opens it in your browser. Only the link's SHA-256 is stored. The
 * link is not printed unless you pass --print, so it does not end up in logs.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { bootConfig } from "@certifier/config";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";

const config = bootConfig("passkey:invite");
if (!config.DATABASE_URL) {
  console.error("passkey:invite: needs DATABASE_URL");
  process.exit(1);
}
const db = createPgDb(config.DATABASE_URL);
try {
  await migrateCertifier(db);
  const token = randomBytes(24).toString("base64url");
  await certifierRepo(db).createPasskeyInvite(createHash("sha256").update(token).digest("hex"), 15);
  const url = `${config.API_BASE_URL.replace(/\/+$/, "")}/owner?invite=${token}`;
  if (process.argv.includes("--print")) {
    console.log(url);
  } else {
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
    console.log(`Opened the passkey registration page on ${new URL(url).origin}/owner in your browser (link valid 15 minutes, single use).`);
    console.log("No browser? Run again with --print to show the link once.");
  }
} finally {
  await db.close();
}
