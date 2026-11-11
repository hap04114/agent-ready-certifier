/**
 * `pnpm apimatic:register` — one-time registration of this app as an OAuth client of APIMatic's
 * ContextMatic MCP server (standard MCP dynamic client registration, client-credentials grant),
 * then a test connection. Writes APIMATIC_CLIENT_ID (and APIMATIC_CLIENT_SECRET when the server
 * issues one) to .env and prints only the outcome and the tool names, never the credentials.
 *
 * ContextMatic registers PUBLIC clients (token_endpoint_auth_methods_supported: ["none"]) and
 * requires at least one redirect URI even though the client-credentials grant never uses it, so
 * we send a loopback placeholder that nothing listens on and no browser is ever sent to.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@certifier/config";
import { CONTEXTMATIC_BASE, openContextMatic } from "./contextmatic.js";

const PLACEHOLDER_REDIRECT = "http://127.0.0.1:53682/unused-callback";

const envPath = join(findRepoRoot()!, ".env");
const reg = await fetch(`${CONTEXTMATIC_BASE}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "agent-ready-certifier",
    redirect_uris: [PLACEHOLDER_REDIRECT],
    grant_types: ["client_credentials"],
    response_types: [],
    token_endpoint_auth_method: "none",
    scope: "mcp:tools",
  }),
});
const body = (await reg.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; error?: string; error_description?: string };
if (!reg.ok || !body.client_id) {
  console.error(`apimatic:register: registration refused (HTTP ${reg.status}${body.error ? `, ${body.error}` : ""}${body.error_description ? `: ${body.error_description}` : ""})`);
  process.exit(1);
}
let text = readFileSync(envPath, "utf8");
const set = (k: string, v: string) => {
  const re = new RegExp(`^${k}=.*$`, "m");
  text = re.test(text) ? text.replace(re, `${k}='${v}'`) : `${text.trimEnd()}\n${k}='${v}'\n`;
};
set("APIMATIC_CLIENT_ID", body.client_id);
set("APIMATIC_CLIENT_SECRET", body.client_secret ?? "");
writeFileSync(envPath, text);
console.log(`apimatic:register: client registered (${body.client_secret ? "with" : "public, no"} secret); wrote APIMATIC_CLIENT_ID${body.client_secret ? " and APIMATIC_CLIENT_SECRET" : ""} to .env`);

try {
  const s = await openContextMatic({ clientId: body.client_id, clientSecret: body.client_secret });
  console.log(`apimatic:register: connected to ContextMatic; tools: ${s.tools.join(", ")}`);
  await s.close();
} catch (err) {
  console.error(`apimatic:register: registered, but the test connection failed: ${err instanceof Error ? err.message : "unknown"}`);
  process.exit(1);
}
