/**
 * `pnpm render:sync` — copy this project's settings from .env to the two Render services and
 * redeploy them. Run it yourself after changing or rotating a key.
 * Needs RENDER_API_KEY in .env. Prints only variable names and statuses, never values.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { findRepoRoot } from "./env.js";

const SERVICES: Record<string, { name: string; keys: string[] }> = {
  "srv-dbp4im0m7kps739qepog": {
    name: "certifier-api",
    keys: [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_WEBHOOK_ID",
      "API_BASE_URL",
      "WEBHOOK_PUBLIC_URL",
      "OWNERSHIP_TOKEN_SECRET",
      "CERTIFIER_ADMIN_TOKEN",
      "KERNEL_API_KEY",
      "LLM_PROVIDER",
      "LLM_MODEL",
      "LLM_API_KEY",
      "PAYPAL_SANDBOX_BUYER_EMAIL",
      "PAYPAL_SANDBOX_BUYER_PASSWORD",
    ],
  },
  "srv-dbp4im0m7kps739qepng": {
    name: "demo-store-good",
    keys: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "DEMO_STORE_GOOD_URL", "DEMO_STORE_GOOD_WEBHOOK_ID", "DEMO_STORE_GOOD_STATUS_KEY", "DEMO_STORE_GOOD_OWNERSHIP_TOKEN"],
  },
};

const env = parse(readFileSync(join(findRepoRoot()!, ".env")));
const apiKey = env.RENDER_API_KEY?.trim();
if (!apiKey) {
  console.error("render:sync: RENDER_API_KEY is empty in .env");
  process.exit(1);
}
const H = { authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const deploys: Record<string, string | undefined> = {};
for (const [id, svc] of Object.entries(SERVICES)) {
  for (const key of svc.keys) {
    const value = env[key]?.trim();
    if (!value) {
      console.log(`${svc.name}  ${key}: empty in .env, skipped`);
      continue;
    }
    const r = await fetch(`https://api.render.com/v1/services/${id}/env-vars/${key}`, { method: "PUT", headers: H, body: JSON.stringify({ value }) });
    console.log(`${svc.name}  ${key}: ${r.ok ? "set" : `FAILED (HTTP ${r.status})`}`);
  }
  const d = await fetch(`https://api.render.com/v1/services/${id}/deploys`, { method: "POST", headers: H, body: JSON.stringify({ clearCache: "do_not_clear" }) });
  deploys[id] = d.ok ? ((await d.json()) as { id: string }).id : undefined;
  console.log(`${svc.name}  deploy: ${deploys[id] ? "started" : `FAILED (HTTP ${d.status})`}`);
}

console.log("Waiting for both deploys (usually 2-4 minutes)...");
const done = new Set<string>();
for (let i = 0; i < 60 && done.size < Object.keys(deploys).length; i++) {
  await sleep(10_000);
  for (const [id, dep] of Object.entries(deploys)) {
    if (done.has(id)) continue;
    if (!dep) {
      done.add(id);
      continue;
    }
    const s = ((await (await fetch(`https://api.render.com/v1/services/${id}/deploys/${dep}`, { headers: H })).json()) as { status: string }).status;
    if (["live", "build_failed", "update_failed", "canceled"].includes(s)) {
      done.add(id);
      console.log(`${SERVICES[id]!.name}: ${s}`);
    }
  }
}
console.log("render:sync: finished");
