import { SANDBOX_API_BASE, parseConfig } from "@certifier/config";
import { describe, expect, it } from "vitest";
import { buildApi } from "./server.js";

describe("api", () => {
  it("reports sandbox on /health", async () => {
    const app = buildApi(parseConfig({ PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: SANDBOX_API_BASE }));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ ok: true, paypalEnv: "sandbox", paypalApiBase: SANDBOX_API_BASE });
  });
});
