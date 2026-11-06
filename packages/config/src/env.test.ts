import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  SANDBOX_API_BASE,
  describeConfig,
  findRepoRoot,
  parseConfig,
  redact,
  requireConfig,
} from "./env.js";

const base = { PAYPAL_ENV: "sandbox", PAYPAL_API_BASE: SANDBOX_API_BASE };

function problemsOf(raw: Record<string, string | undefined>): string[] {
  try {
    parseConfig(raw);
  } catch (err) {
    if (err instanceof ConfigError) return [...err.problems];
    throw err;
  }
  return [];
}

describe("sandbox enforcement", () => {
  it("accepts the sandbox environment and host", () => {
    const config = parseConfig(base);
    expect(config.PAYPAL_ENV).toBe("sandbox");
    expect(config.PAYPAL_API_BASE).toBe(SANDBOX_API_BASE);
  });

  it("accepts the sandbox host with a trailing slash", () => {
    expect(parseConfig({ ...base, PAYPAL_API_BASE: `${SANDBOX_API_BASE}/` }).PAYPAL_API_BASE).toBe(SANDBOX_API_BASE);
  });

  it.each(["live", "production", "Sandbox", "sandbox2"])("refuses PAYPAL_ENV=%s", (value) => {
    expect(problemsOf({ ...base, PAYPAL_ENV: value })).toEqual([expect.stringMatching(/^PAYPAL_ENV: must be "sandbox"/)]);
  });

  it("refuses a missing or empty PAYPAL_ENV", () => {
    expect(problemsOf({ PAYPAL_API_BASE: SANDBOX_API_BASE })).toEqual(["PAYPAL_ENV: is required"]);
    expect(problemsOf({ ...base, PAYPAL_ENV: "" })).toEqual(["PAYPAL_ENV: is required"]);
  });

  it("refuses the live API host", () => {
    const problems = problemsOf({ ...base, PAYPAL_API_BASE: "https://api-m.paypal.com" });
    expect(problems.some((p) => p.startsWith("PAYPAL_API_BASE: points at a live PayPal host"))).toBe(true);
    expect(problems.some((p) => p.startsWith("PAYPAL_API_BASE: must be exactly"))).toBe(true);
  });

  it.each([
    "http://api-m.sandbox.paypal.com",
    "https://api.sandbox.paypal.com",
    "https://api-m.sandbox.paypal.com.evil.example",
    "https://api-m.sandbox.paypal.com/v2",
  ])("refuses a non-exact API base: %s", (value) => {
    expect(problemsOf({ ...base, PAYPAL_API_BASE: value })).toContain(`PAYPAL_API_BASE: must be exactly ${SANDBOX_API_BASE}`);
  });

  it("refuses a missing PAYPAL_API_BASE", () => {
    expect(problemsOf({ PAYPAL_ENV: "sandbox" })).toEqual(["PAYPAL_API_BASE: is required"]);
  });

  it("refuses a live host in any other PayPal or URL variable", () => {
    expect(problemsOf({ ...base, WEBHOOK_PUBLIC_URL: "https://api.paypal.com/hook" })).toContain(
      `WEBHOOK_PUBLIC_URL: points at a live PayPal host; only ${SANDBOX_API_BASE} is allowed`,
    );
  });

  it("does not mistake sandbox hosts for live ones", () => {
    expect(problemsOf({ ...base, APIMATIC_CONTEXT_MCP_URL: "https://chatbotapi.apimatic.io/mcp/plugins" })).toEqual([]);
  });
});

describe("other validation", () => {
  it("applies safety-limit defaults", () => {
    const config = parseConfig(base);
    expect(config.RUN_MAX_REQUESTS).toBe(300);
    expect(config.RUN_MAX_MINUTES).toBe(20);
    expect(config.WEBHOOK_WAIT_SECONDS).toBe(180);
  });

  it("rejects non-positive limits", () => {
    expect(problemsOf({ ...base, RUN_MAX_REQUESTS: "0" })).toEqual(["RUN_MAX_REQUESTS: must be greater than 0"]);
  });

  it("requires https for the webhook listener", () => {
    expect(problemsOf({ ...base, WEBHOOK_PUBLIC_URL: "http://example.com/hook" })).toEqual(["WEBHOOK_PUBLIC_URL: must use https://"]);
  });

  it("treats blank values as not set", () => {
    expect(parseConfig({ ...base, PAYPAL_CLIENT_ID: "   " }).PAYPAL_CLIENT_ID).toBeUndefined();
  });
});

describe("secret handling", () => {
  const secret = "SECRET-VALUE-should-never-leak-123";

  it("never puts a value into a config error", () => {
    const raw = { ...base, PAYPAL_ENV: secret, PAYPAL_API_BASE: `https://${secret}`, RUN_MAX_REQUESTS: secret, WEBHOOK_PUBLIC_URL: secret };
    try {
      parseConfig(raw);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("requireConfig names missing variables without values", () => {
    const config = parseConfig({ ...base, PAYPAL_CLIENT_ID: secret });
    expect(() => requireConfig(config, "PayPal client", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"])).toThrow(
      /PAYPAL_CLIENT_SECRET: is required for PayPal client/,
    );
    try {
      requireConfig(config, "PayPal client", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("requireConfig returns values when present", () => {
    const config = parseConfig({ ...base, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "sec" });
    expect(requireConfig(config, "x", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"])).toEqual({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "sec" });
  });

  it("describeConfig hides sensitive values", () => {
    const config = parseConfig({ ...base, PAYPAL_CLIENT_SECRET: secret, PAYPAL_SANDBOX_BUYER_EMAIL: "buyer@example.com" });
    const described = describeConfig(config);
    expect(JSON.stringify(described)).not.toContain(secret);
    expect(JSON.stringify(described)).not.toContain("buyer@example.com");
    expect(described.PAYPAL_CLIENT_SECRET).toBe("set");
    expect(described.PAYPAL_CLIENT_ID).toBe("not set");
    expect(described.PAYPAL_API_BASE).toBe(SANDBOX_API_BASE);
  });

  it("redact strips secrets from arbitrary text", () => {
    const config = parseConfig({ ...base, PAYPAL_CLIENT_SECRET: secret });
    expect(redact(`auth failed for ${secret}!`, config)).toBe("auth failed for [redacted:PAYPAL_CLIENT_SECRET]!");
  });
});

describe(".env.example", () => {
  const root = findRepoRoot(__dirname);
  const example = parseDotenv(readFileSync(join(root!, ".env.example")));

  it("parses inline comments as empty values, not as the value", () => {
    expect(example.PAYPAL_CLIENT_ID).toBe("");
    expect(example.APP_BASE_URL).toBe("http://localhost:3000");
    expect(example.APIMATIC_CONTEXT_MCP_URL).toBe("https://chatbotapi.apimatic.io/mcp/plugins");
  });

  it("boots as-is (sandbox, no credentials yet)", () => {
    const config = parseConfig(example);
    expect(config.PAYPAL_ENV).toBe("sandbox");
    expect(config.PAYPAL_CLIENT_SECRET).toBeUndefined();
  });

  it("declares every variable the schema knows, and nothing else", async () => {
    const { envSchema } = await import("./env.js");
    expect(Object.keys(example).sort()).toEqual(Object.keys(envSchema.shape).sort());
  });
});
