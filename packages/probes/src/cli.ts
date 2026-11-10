/**
 * `pnpm probe:page <store URL>` — read-only scan of a storefront for the Current and Secure
 * page-level checks (C1, C2, C5, S5, S6, S8). Prints verdicts; secrets appear only masked.
 */
import { judgeC1, judgeC2, judgeC5, judgeS5, judgeS6, judgeS8 } from "@certifier/truth";
import { findLiveHosts, findSecrets, observe, scanStorefront } from "./page.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: pnpm probe:page <store URL>");
  process.exit(2);
}
const scan = await scanStorefront(url);
const o = observe(scan);
const scanned = scan.files.map((f) => f.url);
const verdicts = [
  judgeC1(o),
  judgeC2(o),
  judgeC5(o),
  judgeS5({ scanned, findings: findSecrets(scan.files) }),
  judgeS6({ scanned, liveHostHits: findLiveHosts(scan.files) }),
  judgeS8({ url, status: scan.status, csp: scan.headers["content-security-policy"], hsts: scan.headers["strict-transport-security"] }),
];
for (const v of verdicts) {
  console.log(`${v.status.toUpperCase().padEnd(12)} ${v.check}  ${v.summary}`);
  for (const r of v.reasons) console.log(`               - ${r}`);
}
