/**
 * Certifier API. Milestone 2: boot guard, /health, and the certifier's own webhook listener.
 * The listener receives a COPY of the merchant's PayPal events (store contract item 2) and
 * verifies each signature itself using PAYPAL_WEBHOOK_ID, without any merchant secret.
 * Payloads are stored as untrusted data; nothing here interprets them beyond IDs and types.
 */
import Fastify from "fastify";
import { z } from "zod";
import type { Config } from "@certifier/config";
import type { CertifierRepo } from "@certifier/db";
import { type VerifyResult, verifyWebhook, webhookHeadersFrom } from "@certifier/paypal";
import { type OwnershipVerifier, type RunStarter, registerRunApi } from "./runs.js";

export type WebhookVerifier = (headers: Record<string, string | string[] | undefined>, rawBody: Buffer) => Promise<VerifyResult>;

export interface ApiDeps {
  repo?: CertifierRepo;
  runner?: RunStarter;
  verifyOwnership?: OwnershipVerifier;
  verifyWebhook?: WebhookVerifier;
  logger?: boolean;
}

const eventShape = z.object({
  id: z.string().max(100).optional(),
  event_type: z.string().max(100).optional(),
  resource: z
    .object({
      id: z.string().max(100).optional(),
      supplementary_data: z.object({ related_ids: z.object({ order_id: z.string().max(100).optional() }).optional() }).optional(),
    })
    .passthrough()
    .optional(),
});

export function buildApi(config: Config, deps: ApiDeps = {}) {
  const app = Fastify({
    logger: deps.logger === false ? false : { redact: ["req.headers.authorization", "req.headers.cookie"] },
  });
  const webhookId = config.PAYPAL_WEBHOOK_ID;
  // Each merchant app signs deliveries to our listener with the webhook ID it gave us, so a
  // delivery is genuine if it verifies against ANY known certifier webhook ID.
  let known: { ids: string[]; at: number } = { ids: [], at: 0 };
  const knownIds = async () => {
    if (Date.now() - known.at > 60_000 && deps.repo) known = { ids: await deps.repo.certifierWebhookIds().catch(() => []), at: Date.now() };
    return [...new Set([webhookId, config.DEMO_STORE_BUGGY_CERTIFIER_WEBHOOK_ID, ...known.ids].filter((x): x is string => !!x))];
  };
  const verify: WebhookVerifier =
    deps.verifyWebhook ??
    (async (headers, rawBody) => {
      let last: VerifyResult = { valid: false, reason: "missing_headers" };
      for (const id of await knownIds()) {
        last = await verifyWebhook({ headers: webhookHeadersFrom(headers), rawBody, webhookId: id });
        if (last.valid || last.reason !== "bad_signature") return last;
      }
      return last;
    });

  // Accept an empty JSON body (e.g. POST .../verify sent with content-type but no body).
  // The webhook route keeps its own raw-body parser in its own scope.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }), undefined);
    }
  });

  app.get("/health", async () => ({
    ok: true,
    paypalEnv: config.PAYPAL_ENV,
    paypalApiBase: config.PAYPAL_API_BASE,
    webhookListener: deps.repo && webhookId ? "ready" : "not configured",
  }));

  app.register(async (scope) => {
    // Keep the exact bytes: the signature covers the raw body.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scope.post("/webhooks/paypal", async (req, reply) => {
      if (!deps.repo || !webhookId) return reply.code(503).send({ error: "listener_not_configured" });
      const raw = req.body as Buffer;
      const result = await verify(req.headers, raw);
      let payload: z.infer<typeof eventShape> | undefined;
      try {
        payload = eventShape.parse(JSON.parse(raw.toString("utf8")));
      } catch {
        payload = undefined;
      }
      const transmissionId = webhookHeadersFrom(req.headers).transmissionId;
      await deps.repo.recordWebhook({
        eventId: payload?.id,
        transmissionId,
        type: payload?.event_type,
        resourceId: payload?.resource?.id,
        relatedOrderId: payload?.resource?.supplementary_data?.related_ids?.order_id,
        signatureValid: result.valid,
        verifyReason: result.reason,
        chainVerified: result.chainVerified,
        rawBody: raw,
        payload,
      });
      req.log.info({ eventId: payload?.id, type: payload?.event_type, valid: result.valid, reason: result.reason }, "webhook");
      return result.valid ? reply.code(200).send({ ok: true }) : reply.code(400).send({ error: "invalid_signature" });
    });
  });

  if (deps.repo) registerRunApi(app, { config, repo: deps.repo, runner: deps.runner, verifyOwnership: deps.verifyOwnership });

  return app;
}
