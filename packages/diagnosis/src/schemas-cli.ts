/**
 * `pnpm --filter @certifier/diagnosis apimatic:tools [question]` — print ContextMatic's tool names
 * and input schemas (property names, types, enums; no credentials), and optionally run fetch_api,
 * one `ask` with the given question and two endpoint_search lookups (a real and a made-up method).
 * A dev aid for wiring the diagnosis agent to the server's real tool shapes.
 */
import { loadConfig } from "@certifier/config";
import { CONTEXTMATIC_SDK, askContextMatic } from "./diagnose.js";
import { openContextMatic } from "./contextmatic.js";

const config = loadConfig();
if (!config.APIMATIC_CLIENT_ID) {
  console.error("schemas: APIMATIC_CLIENT_ID is not set (run pnpm apimatic:register)");
  process.exit(1);
}
const s = await openContextMatic({ clientId: config.APIMATIC_CLIENT_ID, clientSecret: config.APIMATIC_CLIENT_SECRET, mcpUrl: config.APIMATIC_CONTEXT_MCP_URL });
try {
  for (const t of s.tools) {
    const sc = s.schemas?.[t];
    const props = Object.entries(sc?.properties ?? {}).map(([k, v]) => {
      const p = v as { type?: string; enum?: unknown[]; description?: string };
      return `${k}:${p.type ?? "?"}${p.enum ? ` enum(${p.enum.slice(0, 8).join("|")})` : ""}${p.description ? ` — ${p.description.slice(0, 90)}` : ""}`;
    });
    console.log(`${t}\n  required: ${(sc?.required ?? []).join(", ") || "-"}\n  ${props.join("\n  ")}`);
  }
  const q = process.argv.slice(2).join(" ");
  if (q) {
    const api = await s.call("fetch_api", { language: CONTEXTMATIC_SDK.language, key: CONTEXTMATIC_SDK.key });
    console.log(`\n--- fetch_api (first 500 chars) ---\n${api.slice(0, 500)}`);
    const r = await askContextMatic(s, q);
    console.log(`\n--- ${r?.tool ?? "no tool"} answer (first 1500 chars) ---\n${r?.text.slice(0, 1500) ?? "(none)"}`);
    const e = await s.call("endpoint_search", { ...CONTEXTMATIC_SDK, query: "createOrder" });
    console.log(`\n--- endpoint_search createOrder (first 700 chars) ---\n${e.slice(0, 700)}`);
    const miss = await s.call("endpoint_search", { ...CONTEXTMATIC_SDK, query: "magicFixOrder" });
    console.log(`\n--- endpoint_search magicFixOrder (first 300 chars) ---\n${miss.slice(0, 300)}`);
  }
} finally {
  await s.close();
}
