/**
 * Certifier API entry point. For Milestone 1 it only proves the boot guard:
 * the process exits before listening if the config is not sandbox-safe.
 * Run API, ownership verifier and webhook listener arrive in later milestones.
 */
import { bootConfig } from "@certifier/config";
import { buildApi } from "./server.js";

const config = bootConfig("api");
const app = buildApi(config);
// Render injects PORT; locally we use the port in API_BASE_URL.
const port = Number(process.env.PORT || new URL(config.API_BASE_URL).port || 4000);

app.listen({ port, host: "0.0.0.0" }).catch((err: unknown) => {
  app.log.error(err instanceof Error ? err.message : "listen failed");
  process.exit(1);
});
