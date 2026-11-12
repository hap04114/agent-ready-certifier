/**
 * Thin store-contract adapter for PayPal's own standard-integration example (Agent-Ready Certifier).
 *
 * It runs the example's Node server UNCHANGED (example/server/server.js) as a child process and
 * stands in front of it, doing only what the example's own Vite dev setup does, plus the store
 * contract (docs/store-contract.md):
 *   - serves the example's page (example/client) with Vite's documented %PAYPAL_CLIENT_ID%
 *     substitution and the certifier's public ownership meta tag (and ownership file);
 *   - forwards /api/* to the example's server byte for byte (as Vite's dev proxy does);
 *   - watches the example's own create/capture responses and reports them at the contract's
 *     status endpoint: GET /.well-known/certifier/orders/{paypalOrderId}, Bearer status key.
 *
 * It never changes a request or a response, never calls PayPal, and adds no security headers, no
 * webhook handler and no test hook: whatever the example lacks, the certifier sees as lacking.
 * Zero dependencies. Sandbox only (the example hard-codes PayPal's sandbox environment).
 */
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = "/.well-known/certifier";
const ORDER_ID = /^[A-Z0-9]{5,40}$/;
const META_NAME = "agent-ready-certifier";

/** What the adapter has seen the example do, per PayPal order. Store-reported evidence only. */
export function createRecorder() {
  const orders = new Map();
  const touch = (id) => {
    let o = orders.get(id);
    if (!o) {
      o = { paypalOrderId: id, status: "created", captureIds: [], refundIds: [], fulfilmentCount: 0, webhookEvents: [] };
      orders.set(id, o);
    }
    o.updatedAt = new Date().toISOString();
    return o;
  };
  return {
    /** The example's POST /api/orders answered; record the order it created. */
    created(httpStatus, body) {
      if (httpStatus >= 200 && httpStatus < 300 && typeof body?.id === "string" && ORDER_ID.test(body.id)) touch(body.id);
    },
    captureStarted(id) {
      const o = touch(id);
      if (o.status === "created") o.status = "capturing";
    },
    /** The example's POST /api/orders/:id/capture answered. */
    captured(id, httpStatus, body) {
      const o = touch(id);
      const captures = (Array.isArray(body?.purchase_units) ? body.purchase_units : []).flatMap((pu) => (Array.isArray(pu?.payments?.captures) ? pu.payments.captures : []));
      const ok = httpStatus >= 200 && httpStatus < 300 && body?.status === "COMPLETED";
      if (ok) {
        for (const c of captures) if (typeof c?.id === "string" && !o.captureIds.includes(c.id)) o.captureIds.push(c.id);
        const amount = captures.find((c) => c?.status === "COMPLETED")?.amount;
        if (amount?.currency_code && amount?.value) o.amount = { currencyCode: amount.currency_code, value: amount.value };
        o.status = "paid";
        // The example's only fulfilment is telling the buyer "Transaction COMPLETED" after a
        // successful capture response, so each successful capture response counts once.
        o.fulfilmentCount += 1;
      } else if (o.status !== "paid") {
        o.status = "failed";
      }
    },
    get: (id) => orders.get(id),
  };
}

const bearerMatches = (header, expected) => {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m || !expected) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const json = (res, status, value) => res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(value));

/**
 * Start the adapter in front of an example server already listening on 127.0.0.1:upstreamPort.
 * Options: { port, upstreamPort, clientDir, clientId, ownershipToken, statusKey }.
 */
export function startAdapter(opts) {
  const recorder = createRecorder();
  const page = () =>
    readFileSync(join(opts.clientDir, "index.html"), "utf8")
      // Vite replaces %PAYPAL_CLIENT_ID% from the environment (the example's envPrefix "PAYPAL").
      .replaceAll("%PAYPAL_CLIENT_ID%", encodeURIComponent(opts.clientId))
      .replace("</head>", `  <meta name="${META_NAME}" content="${opts.ownershipToken}" />\n  </head>`);

  /** Forward a request to the example's server unchanged; hand its response to `observe`. */
  const forward = async (req, res, observe) => {
    const body = await readBody(req);
    const headers = { ...req.headers, host: `127.0.0.1:${opts.upstreamPort}` };
    const up = request({ host: "127.0.0.1", port: opts.upstreamPort, method: req.method, path: req.url, headers }, (ur) => {
      const out = [];
      ur.on("data", (c) => out.push(c));
      ur.on("end", () => {
        const buf = Buffer.concat(out);
        if (observe) {
          try {
            observe(ur.statusCode ?? 502, JSON.parse(buf.toString("utf8") || "null"));
          } catch {
            observe(ur.statusCode ?? 502, undefined);
          }
        }
        const h = { ...ur.headers };
        delete h["transfer-encoding"];
        delete h.connection;
        h["content-length"] = String(buf.length);
        res.writeHead(ur.statusCode ?? 502, h).end(buf);
      });
    });
    up.on("error", () => json(res, 502, { error: "the example server is not reachable" }));
    up.end(body);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://adapter.invalid");
    const path = url.pathname;
    try {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
        return;
      }
      if (req.method === "GET" && path === "/app.js") {
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }).end(readFileSync(join(opts.clientDir, "app.js")));
        return;
      }
      if (req.method === "GET" && path === `${CONTRACT}/ownership.txt`) {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(opts.ownershipToken);
        return;
      }
      if (path.startsWith(`${CONTRACT}/orders/`)) {
        if (!bearerMatches(req.headers.authorization, opts.statusKey)) return json(res, 401, { error: "unauthorized" });
        const id = decodeURIComponent(path.slice(`${CONTRACT}/orders/`.length));
        const o = ORDER_ID.test(id) ? recorder.get(id) : undefined;
        return o ? json(res, 200, o) : json(res, 404, { error: "unknown_order" });
      }
      if (req.method === "POST" && path === "/api/orders") {
        forward(req, res, (status, body) => recorder.created(status, body));
        return;
      }
      const cap = /^\/api\/orders\/([^/]+)\/capture$/.exec(path);
      if (req.method === "POST" && cap) {
        const id = decodeURIComponent(cap[1]);
        if (ORDER_ID.test(id)) recorder.captureStarted(id);
        forward(req, res, (status, body) => ORDER_ID.test(id) && recorder.captured(id, status, body));
        return;
      }
      if (path.startsWith("/api/")) {
        forward(req, res);
        return;
      }
      json(res, 404, { error: "not_found" });
    } catch {
      json(res, 500, { error: "adapter_error" });
    }
  });
  server.listen(opts.port, opts.host ?? "0.0.0.0");
  return { server, recorder };
}

const waitForPort = async (port, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const up = await new Promise((resolve) => {
      const s = connect(port, "127.0.0.1", () => {
        s.end();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

// Run directly (Render): start the example's server, then the adapter in front of it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  if (env.PAYPAL_ENV && env.PAYPAL_ENV !== "sandbox") {
    console.error("adapter: refusing to start: PAYPAL_ENV is not sandbox");
    process.exit(1);
  }
  const missing = ["REALWORLD_PAYPAL_CLIENT_ID", "REALWORLD_PAYPAL_CLIENT_SECRET", "EXAMPLE_STORE_OWNERSHIP_TOKEN", "EXAMPLE_STORE_STATUS_KEY"].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`adapter: missing ${missing.join(", ")}`);
    process.exit(1);
  }
  const port = Number(env.PORT ?? 3000);
  const upstreamPort = Number(env.EXAMPLE_SERVER_PORT ?? 8080);
  // The example gets only what its own .env.example lists (plus PORT and PATH): never the
  // certifier's status key.
  const child = spawn(process.execPath, ["server.js"], {
    cwd: join(HERE, "example", "server"),
    env: { PATH: env.PATH, PORT: String(upstreamPort), PAYPAL_CLIENT_ID: env.REALWORLD_PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: env.REALWORLD_PAYPAL_CLIENT_SECRET },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    console.error(`adapter: the example server exited (${code}); stopping`);
    process.exit(code || 1);
  });
  if (!(await waitForPort(upstreamPort, 30_000))) {
    console.error("adapter: the example server did not start");
    child.kill();
    process.exit(1);
  }
  startAdapter({
    port,
    upstreamPort,
    clientDir: join(HERE, "example", "client"),
    clientId: env.REALWORLD_PAYPAL_CLIENT_ID,
    ownershipToken: env.EXAMPLE_STORE_OWNERSHIP_TOKEN,
    statusKey: env.EXAMPLE_STORE_STATUS_KEY,
  });
  console.log(`adapter: listening on ${port}, example server on 127.0.0.1:${upstreamPort}`);
}
