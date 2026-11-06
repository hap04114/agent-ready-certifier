import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

/** The only PayPal API host this project may ever talk to. */
export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

/** Live PayPal hosts. Their appearance in any PayPal-related variable stops boot. */
const LIVE_HOST_MARKERS = ["api-m.paypal.com", "api.paypal.com", "api-3t.paypal.com"];

/**
 * Variables whose values must never appear in logs, errors or test output.
 * describeConfig() shows these only as "set" / "not set".
 */
export const SENSITIVE_KEYS = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_SANDBOX_BUYER_EMAIL",
  "PAYPAL_SANDBOX_BUYER_PASSWORD",
  "PAYPAL_WEBHOOK_ID",
  "DEMO_STORE_GOOD_WEBHOOK_ID",
  "DEMO_STORE_GOOD_STATUS_KEY",
  "PAYPAL_LOOKALIKE_CLIENT_ID",
  "PAYPAL_LOOKALIKE_CLIENT_SECRET",
  "DATABASE_URL",
  "QUEUE_URL",
  "LLM_API_KEY",
  "KERNEL_API_KEY",
  "CHANNEL3_API_KEY",
  "OWNERSHIP_TOKEN_SECRET",
  "CERT_SIGNING_PRIVATE_KEY",
  "TESTNET_RPC_URL",
  "TESTNET_WALLET_PRIVATE_KEY",
] as const;

/** Empty strings in .env mean "not set". */
const blankToUndefined = (v: unknown) =>
  typeof v === "string" ? (v.trim() === "" ? undefined : v.trim()) : v;

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const optionalUrl = z.preprocess(blankToUndefined, z.url({ error: "must be a valid URL" }).optional());
const urlWithDefault = (fallback: string) =>
  z.preprocess(blankToUndefined, z.url({ error: "must be a valid URL" }).default(fallback));
const positiveInt = (fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number({ error: "must be a number" }).int({ error: "must be a whole number" }).positive({ error: "must be greater than 0" }).default(fallback),
  );

export const envSchema = z.object({
  // General
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(["development", "test", "production"], { error: "must be development, test or production" }).default("development"),
  ),
  APP_BASE_URL: urlWithDefault("http://localhost:3000"),
  API_BASE_URL: urlWithDefault("http://localhost:4000"),

  // PayPal sandbox. Both are required and fixed: there is no way to configure a live host.
  PAYPAL_ENV: z.preprocess(
    blankToUndefined,
    z.literal("sandbox", { error: 'must be "sandbox" (this project never talks to live PayPal)' }),
  ),
  PAYPAL_API_BASE: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().replace(/\/+$/, "") || undefined : v),
    z.literal(SANDBOX_API_BASE, { error: `must be exactly ${SANDBOX_API_BASE}` }),
  ),
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_SANDBOX_BUYER_EMAIL: optionalString,
  PAYPAL_SANDBOX_BUYER_PASSWORD: optionalString,

  // Webhooks (Milestone 2)
  PAYPAL_WEBHOOK_ID: optionalString,
  WEBHOOK_PUBLIC_URL: z.preprocess(
    blankToUndefined,
    z.url({ error: "must be a valid URL" }).refine((u) => u.startsWith("https://"), { error: "must use https://" }).optional(),
  ),

  // Demo store "good" (a separate merchant system)
  DEMO_STORE_GOOD_URL: urlWithDefault("http://localhost:5001"),
  DEMO_STORE_GOOD_WEBHOOK_ID: optionalString,
  DEMO_STORE_GOOD_STATUS_KEY: optionalString,

  // Lookalike merchant (Milestone 6)
  PAYPAL_LOOKALIKE_CLIENT_ID: optionalString,
  PAYPAL_LOOKALIKE_CLIENT_SECRET: optionalString,

  // Database and queue
  DATABASE_URL: optionalString,
  QUEUE_URL: optionalString,

  // AI
  LLM_PROVIDER: optionalString,
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,

  // Sponsor tools
  KERNEL_API_KEY: optionalString,
  CHANNEL3_API_KEY: optionalString,
  APIMATIC_CONTEXT_MCP_URL: optionalUrl,

  // Safety limits
  RUN_MAX_REQUESTS: positiveInt(300),
  RUN_MAX_MINUTES: positiveInt(20),
  WEBHOOK_WAIT_SECONDS: positiveInt(180),

  // Ownership verification
  OWNERSHIP_TOKEN_SECRET: optionalString,

  // Trust layer
  CERT_SIGNING_PRIVATE_KEY: optionalString,
  WEBAUTHN_RP_ID: z.preprocess(blankToUndefined, z.string().default("localhost")),
  WEBAUTHN_RP_NAME: z.preprocess(blankToUndefined, z.string().default("Agent-Ready Certifier")),
  TESTNET_RPC_URL: optionalString,
  TESTNET_WALLET_PRIVATE_KEY: optionalString,
});

export type Config = Readonly<z.infer<typeof envSchema>>;
export type ConfigKey = keyof Config;

/** Thrown when configuration is unsafe or incomplete. Messages name variables, never values. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[],
  ) {
    super(`${message}\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/**
 * Sandbox guard that runs before schema validation. Rejects any PayPal-related or URL
 * variable that points at a live PayPal host.
 */
export function findLiveHostProblems(raw: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!value) continue;
    const relevant = key.startsWith("PAYPAL_") || key.endsWith("_URL") || key.endsWith("_BASE");
    if (!relevant) continue;
    const lower = value.toLowerCase();
    if (LIVE_HOST_MARKERS.some((h) => lower.includes(`//${h}`) || lower === h || lower.startsWith(`${h}/`))) {
      problems.push(`${key}: points at a live PayPal host; only ${SANDBOX_API_BASE} is allowed`);
    }
  }
  return problems;
}

/** Validate a plain record of env values. Pure: no file or process access. */
export function parseConfig(raw: Record<string, string | undefined>): Config {
  const problems = findLiveHostProblems(raw);

  const result = envSchema.safeParse(raw);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "(root)";
      // Missing required values get a clearer message than zod's default.
      const isBlank = (raw[key] ?? "").trim() === "";
      const message = issue.code === "invalid_value" && isBlank ? "is required" : issue.message;
      problems.push(`${key}: ${message}`);
    }
  }

  if (problems.length > 0 || !result.success) {
    throw new ConfigError("Refusing to start: configuration is not sandbox-safe or is invalid.", problems);
  }
  return Object.freeze(result.data);
}

/** Walk up from `start` to the folder holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadConfigOptions {
  /** Path to a .env file. Defaults to <repo root>/.env when present. */
  envFile?: string;
  /** Environment to read. Defaults to process.env. Real environment wins over the file. */
  env?: Record<string, string | undefined>;
}

/**
 * Load .env (if present) under the real environment and validate it.
 * Does not mutate process.env, so values are not leaked into child processes.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const envFile = options.envFile ?? (() => {
    const root = findRepoRoot();
    return root ? join(root, ".env") : undefined;
  })();
  const fileValues = envFile && existsSync(envFile) ? parseDotenv(readFileSync(envFile)) : {};
  return parseConfig({ ...fileValues, ...(options.env ?? process.env) });
}

type Required<K extends ConfigKey> = { readonly [P in K]-?: NonNullable<Config[P]> };

/**
 * Return the named values, or throw a ConfigError that lists which ones are empty and
 * what feature needs them. Call this at the point a feature first needs credentials.
 */
export function requireConfig<K extends ConfigKey>(config: Config, feature: string, keys: readonly K[]): Required<K> {
  const missing = keys.filter((k) => config[k] === undefined || config[k] === "");
  if (missing.length > 0) {
    throw new ConfigError(`${feature} needs environment variables that are empty.`, missing.map((k) => `${k}: is required for ${feature}`));
  }
  return Object.fromEntries(keys.map((k) => [k, config[k]])) as Required<K>;
}

/** A safe-to-print view of the config: sensitive values are replaced with set / not set. */
export function describeConfig(config: Config): Record<string, string> {
  const sensitive = new Set<string>(SENSITIVE_KEYS);
  const out: Record<string, string> = {};
  for (const key of Object.keys(envSchema.shape) as ConfigKey[]) {
    const value = config[key];
    if (sensitive.has(key)) out[key] = value === undefined ? "not set" : "set";
    else out[key] = value === undefined ? "not set" : String(value);
  }
  return out;
}

/** Replace every known secret value inside a string with [redacted]. For log lines and errors. */
export function redact(text: string, config: Config): string {
  let out = text;
  for (const key of SENSITIVE_KEYS) {
    const value = config[key];
    if (typeof value === "string" && value.length >= 4) out = out.split(value).join(`[redacted:${key}]`);
  }
  return out;
}
