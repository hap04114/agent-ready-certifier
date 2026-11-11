/**
 * `pnpm realworld:serve <path to an example's front-end folder> [--port 3000]` — host a third-party
 * PayPal front end on OUR OWN local "staging" so its ownership is genuine: we serve its static
 * files unchanged except for (1) the public sandbox client ID in place of the documented
 * placeholder and (2) our ownership meta tag. Nothing of theirs is installed or run on this
 * machine (no npm install, no server code); only the public client ID is used, never a secret.
 * API routes answer 503: the example's server is deliberately not run.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { bootConfig } from "@certifier/config";
import { OWNERSHIP_META_NAME, deriveOwnershipToken } from "@certifier/contract";

const config = bootConfig("realworld:serve");
const dir = process.argv[2];
const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 3000;
if (!dir || !config.REALWORLD_PAYPAL_CLIENT_ID || !config.OWNERSHIP_TOKEN_SECRET) {
  console.error("usage: pnpm realworld:serve <front-end folder> [--port 3000]  (needs REALWORLD_PAYPAL_CLIENT_ID and OWNERSHIP_TOKEN_SECRET)");
  process.exit(2);
}
const origin = `http://127.0.0.1:${port}`;
const token = deriveOwnershipToken(config.OWNERSHIP_TOKEN_SECRET, origin);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

createServer((req, res) => {
  const path = new URL(req.url ?? "/", origin).pathname;
  if (path.startsWith("/api/")) {
    res.writeHead(503, { "content-type": "application/json" }).end('{"error":"the example server is not run in this study"}');
    return;
  }
  const rel = path === "/" ? "index.html" : normalize(path).replace(/^[\\/]+/, "");
  if (rel.includes("..") || !TYPES[extname(rel)]) {
    res.writeHead(404).end();
    return;
  }
  try {
    let body = readFileSync(join(dir, rel), "utf8");
    if (rel === "index.html") {
      body = body
        .replaceAll("%PAYPAL_CLIENT_ID%", encodeURIComponent(config.REALWORLD_PAYPAL_CLIENT_ID!))
        .replace("</head>", `  <meta name="${OWNERSHIP_META_NAME}" content="${token}">\n  </head>`);
    }
    res.writeHead(200, { "content-type": TYPES[extname(rel)]! }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`realworld:serve: ${origin} serving ${dir} (static files only; ownership meta added)`));
