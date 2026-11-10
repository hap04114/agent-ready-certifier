/**
 * Run API (Milestone 4, kept lean):
 *   POST /api/stores               {url, storeWebhookId?}   register a store; returns its ownership token
 *   POST /api/stores/:id/verify                             check the store serves the token
 *   POST /api/runs                 {storeId}                start a Works run (store must verify again)
 *   GET  /api/runs/:id                                      status, verdicts and evidence (public)
 *   POST /api/runs/:id/stop                                 kill switch
 * Writes need `Authorization: Bearer <CERTIFIER_ADMIN_TOKEN>`. One run at a time.
 * The store webhook ID (extended contract) is stored as configuration and never returned.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "@certifier/config";
import { bearerMatches, deriveOwnershipToken, deriveStatusKey, storeOrigin, verifyOwnership } from "@certifier/contract";
import type { CertifierRepo } from "@certifier/db";
import { impactOf, scoreCell } from "@certifier/truth";

export interface RunStarter {
  /** Start a run in the background. Returns a kill function for the kill switch. */
  start(args: { runId: string; store: { url: string; statusKey: string; webhookId?: string; demoHooks: boolean } }): { kill: () => void };
}

export type OwnershipVerifier = typeof verifyOwnership;

export interface RunApiDeps {
  config: Config;
  repo: CertifierRepo;
  runner?: RunStarter;
  verifyOwnership?: OwnershipVerifier;
}

const uuid = z.object({ id: z.uuid() });
const newStore = z.object({
  url: z.url().max(300),
  storeWebhookId: z.string().regex(/^[A-Z0-9-]{5,40}$/).optional(),
  certifierWebhookId: z.string().regex(/^[A-Z0-9-]{5,40}$/).optional(),
  demoHooks: z.boolean().optional(),
});

export function registerRunApi(app: FastifyInstance, deps: RunApiDeps) {
  const { config, repo } = deps;
  const verify = deps.verifyOwnership ?? verifyOwnership;
  const kills = new Map<string, () => void>();

  const admin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!config.CERTIFIER_ADMIN_TOKEN) {
      reply.code(503).send({ error: "admin_token_not_configured" });
      return false;
    }
    if (!bearerMatches(req.headers.authorization, config.CERTIFIER_ADMIN_TOKEN)) {
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  };
  const secret = (reply: FastifyReply): string | undefined => {
    if (!config.OWNERSHIP_TOKEN_SECRET || config.OWNERSHIP_TOKEN_SECRET.length < 32) {
      reply.code(503).send({ error: "ownership_secret_not_configured" });
      return undefined;
    }
    return config.OWNERSHIP_TOKEN_SECRET;
  };

  app.post("/api/stores", async (req, reply) => {
    if (!admin(req, reply)) return;
    const s = secret(reply);
    if (!s) return;
    const body = newStore.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const url = storeOrigin(body.data.url);
    const token = deriveOwnershipToken(s, url);
    const id = await repo.createStore({
      url,
      ownershipToken: token,
      storeWebhookId: body.data.storeWebhookId,
      certifierWebhookId: body.data.certifierWebhookId,
      demoHooks: body.data.demoHooks,
    });
    return reply.code(201).send({
      id,
      url,
      ownershipToken: token,
      instructions: [
        `Serve the token on your store, either as <meta name="agent-ready-certifier" content="${token}"> on the home page,`,
        "or as the body of /.well-known/certifier/ownership.txt. Then call POST /api/stores/:id/verify.",
      ],
    });
  });

  app.post("/api/stores/:id/verify", async (req, reply) => {
    if (!admin(req, reply)) return;
    const p = uuid.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_id" });
    const store = await repo.getStore(p.data.id);
    if (!store) return reply.code(404).send({ error: "unknown_store" });
    const r = await verify(store.url, store.ownership_token);
    await repo.recordOwnershipCheck(store.id, r.verified ? { verified: true, method: r.method, detail: `verified via ${r.method}` } : { verified: false, detail: r.reason });
    return reply.send(r.verified ? { verified: true, method: r.method } : { verified: false, reason: r.reason });
  });

  app.post("/api/runs", async (req, reply) => {
    if (!admin(req, reply)) return;
    const s = secret(reply);
    if (!s) return;
    if (!deps.runner) return reply.code(503).send({ error: "runner_not_configured" });
    const body = z.object({ storeId: z.uuid() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const store = await repo.getStore(body.data.storeId);
    if (!store) return reply.code(404).send({ error: "unknown_store" });
    if ((await repo.activeRuns()).length > 0) return reply.code(409).send({ error: "a_run_is_already_in_progress" });

    // Ownership is checked again at every run: no probe runs against a store that stopped serving its token.
    const runId = await repo.createRun({ storeUrl: store.url, storeId: store.id, status: "requested", budgetRequests: config.RUN_MAX_REQUESTS, timeLimitMin: config.RUN_MAX_MINUTES });
    const own = await verify(store.url, store.ownership_token);
    await repo.recordOwnershipCheck(store.id, own.verified ? { verified: true, method: own.method, detail: `verified via ${own.method}` } : { verified: false, detail: own.reason });
    if (!own.verified) {
      await repo.finishRun(runId, "stopped", 0, { stoppedBecause: "ownership not verified", detail: own.reason });
      return reply.code(403).send({ error: "ownership_not_verified", reason: own.reason, runId });
    }
    await repo.setRunStatus(runId, "ownership_verified");
    const handle = deps.runner.start({
      runId,
      store: { url: store.url, statusKey: deriveStatusKey(s, store.url), webhookId: store.store_webhook_id ?? undefined, demoHooks: store.demo_hooks },
    });
    kills.set(runId, handle.kill);
    return reply.code(202).send({ runId, status: "running" });
  });

  app.get("/api/runs", async () => ({ runs: await repo.listRuns() }));

  app.get("/api/runs/:id", async (req, reply) => {
    const p = uuid.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_id" });
    const run = await repo.getRun(p.data.id);
    if (!run) return reply.code(404).send({ error: "unknown_run" });
    const notes = (run.notes ?? {}) as { log?: string[]; recording?: unknown; orders?: unknown; error?: unknown };
    return reply.send({
      ...run,
      notes: undefined,
      recording: notes.recording ?? null,
      orders: notes.orders ?? null,
      log: notes.log ?? [],
      error: typeof notes.error === "string" ? notes.error : null,
      checks: run.checks.map((c) => ({ ...c, businessImpact: c.status === "fail" ? (impactOf(c.code) ?? null) : null })),
    });
  });

  app.get("/api/stores", async () => ({ stores: await repo.listStores() }));

  app.get("/api/trials", async () => ({ trials: (await repo.listTrials()).map((t) => ({ ...t, errored: t.status === "error" })) }));

  /** Model safety scorecard: one cell per model × scenario, judged trials only, with the actual N. */
  app.get("/api/scorecard", async () => {
    const trials = await repo.listTrials(5000);
    const cells = new Map<string, typeof trials>();
    for (const t of trials) {
      const k = `${t.provider}:${t.model}|${t.scenario}`;
      cells.set(k, [...(cells.get(k) ?? []), t]);
    }
    return {
      caveat: "Sandbox only. Our own scenarios, modelled on the I-HITL study, WASP and WebDecept; small N. Errored trials are excluded from every rate.",
      cells: [...cells.entries()].map(([k, ts]) => {
        const [model, scenario] = k.split("|");
        const c = scoreCell(
          ts.map((t) => ({ errored: t.status === "error", bypassed: t.bypassed, wrongPayee: t.wrong_payee, trapFollowed: t.trap_followed, safeStop: t.safe_stop, taskSuccess: t.task_success })),
        );
        return { model, scenario, ...c };
      }),
    };
  });

  app.post("/api/runs/:id/stop", async (req, reply) => {
    if (!admin(req, reply)) return;
    const p = uuid.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_id" });
    const kill = kills.get(p.data.id);
    if (!kill) return reply.code(404).send({ error: "no_active_run_with_that_id" });
    kill();
    kills.delete(p.data.id);
    return reply.code(202).send({ runId: p.data.id, status: "stopping" });
  });

  return { forget: (runId: string) => kills.delete(runId) };
}
