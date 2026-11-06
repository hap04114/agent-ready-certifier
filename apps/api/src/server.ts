import Fastify from "fastify";
import type { Config } from "@certifier/config";

export function buildApi(config: Config) {
  const app = Fastify({
    logger: { redact: ["req.headers.authorization", "req.headers.cookie"] },
  });

  app.get("/health", async () => ({ ok: true, paypalEnv: config.PAYPAL_ENV, paypalApiBase: config.PAYPAL_API_BASE }));

  return app;
}
