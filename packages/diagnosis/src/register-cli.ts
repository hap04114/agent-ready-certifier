/**
 * `pnpm apimatic:register` — one-time registration of this app as an OAuth client of APIMatic's
 * ContextMatic MCP server (standard MCP dynamic client registration, client-credentials grant),
 * then a test connection. Writes APIMATIC_CLIENT_ID / APIMATIC_CLIENT_SECRET to .env and prints
 * only the outcome and the tool names, never the credentials.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@certifier/config";
import { CONTEXTMATIC_BASE, openContextMatic } from "./contextmatic.js";

const envPath = join(findRepoRoot()!, ".env");
const reg = await fetch(`${CONTEXTMATIC_BASE}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "agent-ready-certifier", grant_types: ["client_credentials"], token_endpoint_auth_method: "client_secret_post", scope: "mcp:tools" }),
});
const body = (await reg.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; error?: string; error_description?: string };
if (!reg.ok || !body.client_id || !body.client_secret) {
  console.error(`apimatic:register: registration refused (HTTP ${reg.status}${body.error ? `, ${body.error}` : ""}${body.error_description ? `: ${body.error_description}` : ""})`);
  process.exit(1);
}
let text = readFileSync(envPath, "utf8");
const set = (k: string, v: string) => {
  const re = new RegExp(`^${k}=.*$`, "m");
  text = re.test(text) ? text.replace(re, `${k}='${v}'`) : `${text.trimEnd()}\n${k}='${v}'\n`;
};
set("APIMATIC_CLIENT_ID", body.client_id);
set("APIMATIC_CLIENT_SECRET", body.client_secret);
writeFileSync(envPath, text);
console.log("apimatic:register: client registered; wrote APIMATIC_CLIENT_ID and APIMATIC_CLIENT_SECRET to .env");

try {
  const s = await openContextMatic({ clientId: body.client_id, clientSecret: body.client_secret });
  console.log(`apimatic:register: connected to ContextMatic; tools: ${s.tools.join(", ")}`);
  await s.close();
} catch (err) {
  console.error(`apimatic:register: registered, but the test connection failed: ${err instanceof Error ? err.message : "unknown"}`);
  process.exit(1);
}
