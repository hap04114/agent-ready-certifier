/**
 * Client for APIMatic's ContextMatic hosted MCP server (version-aware PayPal Server SDK context).
 * Auth is standard MCP OAuth: a client registered once (`pnpm apimatic:register`) gets tokens
 * with the client-credentials grant. Tokens and client secrets are never logged.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const CONTEXTMATIC_BASE = "https://chatbotapi.apimatic.io";
export const CONTEXTMATIC_MCP_URL = `${CONTEXTMATIC_BASE}/mcp/plugins`;

export interface ContextMaticCredentials {
  clientId: string;
  /** ContextMatic issues public clients (auth method "none"), so there may be no secret. */
  clientSecret?: string;
  mcpUrl?: string;
}

export async function contextMaticToken(creds: ContextMaticCredentials, fetcher: typeof fetch = fetch): Promise<string> {
  // MCP auth requires the RFC 8707 `resource` indicator: the token is bound to the MCP server URL.
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientId, scope: "mcp:tools", resource: creds.mcpUrl ?? CONTEXTMATIC_MCP_URL });
  if (creds.clientSecret) form.set("client_secret", creds.clientSecret);
  const res = await fetcher(`${CONTEXTMATIC_BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    const why = body.error_description ? `: ${body.error_description.replaceAll(creds.clientId, "[client]").slice(0, 160)}` : "";
    throw new Error(`ContextMatic token refused (HTTP ${res.status}${body.error ? `, ${body.error}` : ""}${why})`);
  }
  return body.access_token;
}

export interface ContextMaticSession {
  tools: string[];
  schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  /** Call a tool; returns the text content only. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

export async function openContextMatic(creds: ContextMaticCredentials): Promise<ContextMaticSession> {
  const token = await contextMaticToken(creds);
  const transport = new StreamableHTTPClientTransport(new URL(creds.mcpUrl ?? CONTEXTMATIC_MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}`, "X-Apimatic-Mcp-Client": "agent-ready-certifier" } },
  });
  const client = new Client({ name: "agent-ready-certifier", version: "0.1.0" });
  await client.connect(transport);
  const listed = (await client.listTools()).tools;
  const tools = listed.map((t) => t.name);
  const schemas = Object.fromEntries(listed.map((t) => [t.name, t.inputSchema as { properties?: Record<string, unknown>; required?: string[] }]));
  return {
    tools,
    schemas,
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const content = (res.content ?? []) as { type: string; text?: string }[];
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text!)
        .join("\n")
        .slice(0, 12_000);
      // A tool error must never be passed on as if it were SDK reference text.
      if (res.isError || /^Invalid arguments for '/.test(text)) throw new Error(`ContextMatic ${name} failed: ${text.slice(0, 160)}`);
      return text;
    },
    close: () => client.close(),
  };
}
