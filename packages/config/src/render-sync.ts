/**
 * `pnpm render:sync` — copy this project's settings from .env to the Render services (found by
 * name; services that do not exist yet are skipped) and redeploy them. Run it yourself after
 * changing or rotating a key.
 * Needs RENDER_API_KEY in .env. Prints only variable names and statuses, never values.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { findRepoRoot } from "./env.js";

const SERVICES: Record<string, { name: string; keys: string[] }> = {
  "certifier-api": {
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
      "LLM_FALLBACK_MODELS",
      "CERT_SIGNING_KEY",
      "LLM_API_KEY",
      "PAYPAL_SANDBOX_BUYER_EMAIL",
      "PAYPAL_SANDBOX_BUYER_PASSWORD",
      "DEMO_STORE_BUGGY_CERTIFIER_WEBHOOK_ID",
      "APIMATIC_CLIENT_ID",
      "APIMATIC_CLIENT_SECRET",
    ],
  },
  "demo-store-good": {
    name: "demo-store-good",
    keys: ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "DEMO_STORE_GOOD_URL", "DEMO_STORE_GOOD_WEBHOOK_ID", "DEMO_STORE_GOOD_STATUS_KEY", "DEMO_STORE_GOOD_OWNERSHIP_TOKEN"],
  },
  "demo-store-buggy": {
    name: "demo-store-buggy",
    keys: [
      "DEMO_STORE_BUGGY_URL",
      "DEMO_STORE_BUGGY_PAYPAL_CLIENT_ID",
      "DEMO_STORE_BUGGY_PAYPAL_CLIENT_SECRET",
      "DEMO_STORE_BUGGY_WEBHOOK_ID",
      "DEMO_STORE_BUGGY_STATUS_KEY",
      "DEMO_STORE_BUGGY_OWNERSHIP_TOKEN",
    ],
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
/** Render sometimes answers 202 with an empty body; never crash on that. */
const jsonOrUndefined = async <T>(r: Response): Promise<T | undefined> => {
  const text = await r.text().catch(() => "");
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
};
/** The newest deploy of a service (used when the trigger response carried no deploy id). */
const latestDeploy = async (serviceId: string) =>
  (await jsonOrUndefined<{ deploy: { id: string } }[]>(await fetch(`https://api.render.com/v1/services/${serviceId}/deploys?limit=1`, { headers: H })))?.[0]?.deploy.id;

// Resolve service IDs by name.
const listedRes = await fetch("https://api.render.com/v1/services?limit=50", { headers: H });
const listed = await jsonOrUndefined<{ service: { id: string; name: string } }[]>(listedRes);
if (!listedRes.ok || !listed) {
  console.error(`render:sync: could not list Render services (HTTP ${listedRes.status})`);
  process.exit(1);
}
const idByName = new Map(listed.map((x) => [x.service.name, x.service.id]));

const deploys: Record<string, string | undefined> = {};
for (const [name, svc] of Object.entries(SERVICES)) {
  const id = idByName.get(name);
  if (!id) {
    console.log(`${name}: no such Render service yet, skipped`);
    continue;
  }
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
  deploys[id] = d.ok ? ((await jsonOrUndefined<{ id?: string }>(d))?.id ?? (await latestDeploy(id))) : undefined;
  console.log(`${svc.name}  deploy: ${d.ok ? "started" : `FAILED (HTTP ${d.status})`}`);
}

console.log("Waiting for the deploys (usually 2-4 minutes)...");
const done = new Set<string>();
for (let i = 0; i < 60 && done.size < Object.keys(deploys).length; i++) {
  await sleep(10_000);
  for (const [id, dep] of Object.entries(deploys)) {
    if (done.has(id)) continue;
    if (!dep) {
      done.add(id);
      continue;
    }
    const s = (await jsonOrUndefined<{ status?: string }>(await fetch(`https://api.render.com/v1/services/${id}/deploys/${dep}`, { headers: H })))?.status ?? "unknown";
    if (["live", "build_failed", "update_failed", "canceled", "deactivated"].includes(s)) {
      done.add(id);
      console.log(`${[...idByName.entries()].find(([, v]) => v === id)?.[0] ?? id}: ${s}`);
    }
  }
}
console.log("render:sync: finished");
