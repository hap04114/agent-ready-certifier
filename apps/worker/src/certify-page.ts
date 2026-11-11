/**
 * `pnpm certify:page <store url>` — page-level certification for ANY store that has only added the
 * ownership token (no store contract): C1–C5, S5, S6, S8, A4, A5, decided by the same plain-code
 * rules as a full run. Browser measurements (C3, rendered Pay Later/Venmo, A5) use a local Edge or
 * Chrome, so local staging sites work too. The run is stored like any other and can be certified.
 * Checks that need the store contract or real purchases (W1–W6, S1–S4, S7) are not run, and the
 * report says so; they are never guessed.
 */
import { bootConfig } from "@certifier/config";
import { deriveOwnershipToken, verifyOwnership } from "@certifier/contract";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { findLiveHosts, findSecrets, launchLocalBrowser, measureStorefront, observe, scanStorefront, structuredOffers } from "@certifier/probes";
import {
  type StorefrontObservation,
  type Verdict,
  judgeA4,
  judgeA5,
  judgeC1,
  judgeC2,
  judgeC3,
  judgeC4,
  judgeC5,
  judgeS5,
  judgeS6,
  judgeS8,
} from "@certifier/truth";
import { pillarOf } from "./works.js";

const config = bootConfig("certify:page");
const target = process.argv[2];
if (!target || !config.DATABASE_URL || !config.OWNERSHIP_TOKEN_SECRET) {
  console.error("usage: pnpm certify:page <store url>   (needs DATABASE_URL and OWNERSHIP_TOKEN_SECRET)");
  process.exit(2);
}
const storeUrl = new URL(target).origin;
const db = createPgDb(config.DATABASE_URL);
const repo = certifierRepo(db);
const t0 = Date.now();
const timeline: { name: string; kind: string; start: number; end: number; note?: string }[] = [];
const step = (name: string, kind: string) => {
  const start = (Date.now() - t0) / 1000;
  return (note?: string) => void timeline.push({ name, kind, start, end: (Date.now() - t0) / 1000, ...(note ? { note } : {}) });
};
const notes: Record<string, unknown> = { mode: "page-only", timeline, notRun: "W1-W6, S1-S4, S7 need the store contract or real purchases; not run, never guessed." };

try {
  await migrateCertifier(db);
  const runId = await repo.createRun({ storeUrl, budgetRequests: 50, timeLimitMin: 10 });
  console.log(`Run ${runId} (page-only) against ${storeUrl}`);
  const ownDone = step("Ownership check", "setup");
  const own = await verifyOwnership(storeUrl, deriveOwnershipToken(config.OWNERSHIP_TOKEN_SECRET, storeUrl));
  ownDone(own.verified ? `verified via ${own.method}` : "not verified");
  if (!own.verified) {
    console.log(`Ownership NOT verified (${own.reason}); nothing was tested.`);
    await repo.finishRun(runId, "stopped", 0, { ...notes, stoppedBecause: "ownership not verified", detail: own.reason });
    process.exit(1);
  }
  await repo.setRunStatus(runId, "running");

  const scanDone = step("Page scan", "setup");
  let requests = 0;
  const scan = await scanStorefront(`${storeUrl}/`, { spend: () => void requests++ });
  scanDone(`HTTP ${scan.status ?? "?"}, ${scan.files.length} files`);

  let rendered: StorefrontObservation["rendered"];
  const browserDone = step("Browser measurement (C3, A5)", "agent");
  try {
    const local = await launchLocalBrowser();
    try {
      rendered = await measureStorefront(local.context, storeUrl);
      notes.browser = local.name;
    } finally {
      await local.browser.close();
    }
    browserDone(notes.browser as string);
  } catch (err) {
    browserDone("unavailable");
    console.log(`Browser measurement unavailable (${err instanceof Error ? err.message : "error"}); C3 and A5 will be inconclusive.`);
  }

  const judgeDone = step("Page checks and judging", "judge");
  const page: StorefrontObservation = { ...observe(scan), rendered };
  const scanned = scan.files.map((x) => x.url);
  const verdicts: Verdict[] = [
    judgeC1(page),
    judgeC2(page),
    judgeC3(page),
    judgeC4({ configured: false, url: page.url }),
    judgeC5(page),
    judgeS5({ scanned, findings: findSecrets(scan.files) }),
    judgeS6({ scanned, liveHostHits: findLiveHosts(scan.files) }),
    judgeS8({ url: `${storeUrl}/`, status: scan.status, csp: scan.headers["content-security-policy"], hsts: scan.headers["strict-transport-security"] }),
    judgeA4({ url: page.url, fetched: page.fetched, offers: structuredOffers(scan.html), charged: [] }),
    judgeA5({ url: page.url, controls: rendered?.controls }),
  ];
  judgeDone();
  for (const v of verdicts) await repo.saveVerdict(runId, pillarOf(v.check), v);
  await repo.finishRun(runId, "judged", requests, notes);
  for (const v of verdicts) console.log(`${v.status.toUpperCase().padEnd(12)} ${v.check}  ${v.summary}${v.reasons.length ? `\n               - ${v.reasons.join("\n               - ")}` : ""}`);
  console.log(`\nRun ${runId} judged (page-only): ${verdicts.filter((v) => v.status === "pass").length} pass, ${verdicts.filter((v) => v.status === "fail").length} fail, ${verdicts.filter((v) => v.status === "inconclusive").length} inconclusive.`);
} finally {
  await db.close();
}
