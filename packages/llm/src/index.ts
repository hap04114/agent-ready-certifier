/**
 * Minimal JSON-only LLM client: Groq, Gemini, and "local" (an OpenAI-compatible server on this
 * machine, e.g. llama.cpp running an open-weights model; nothing leaves the computer).
 * Every call returns JSON validated against a zod schema (CLAUDE.md rule 6). Free text never
 * leaves this module. Keys come from the caller; they are never logged.
 */
import type { z } from "zod";

export type Provider = "groq" | "gemini" | "local";

export interface LlmConfig {
  provider: Provider;
  model: string;
  /** Not used for "local". */
  apiKey: string;
  /** "local" only: the OpenAI-compatible server on this machine (default http://127.0.0.1:8080/v1). */
  baseUrl?: string;
  timeoutMs?: number;
  /** Minimum gap between calls to this provider (defaults: Gemini 7 s, Groq none). */
  minIntervalMs?: number;
  /**
   * Same-provider models to switch to, in order, when a model's DAILY quota is used up (free
   * tiers give each model its own quota). Per-minute limits are waited out, never switched.
   */
  fallbackModels?: string[];
  /** Told whenever a call switches model, so runs can record which model really answered. */
  onFallback?: (from: string, to: string, reason: string) => void;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** A daily (not per-minute) quota refused the call. */
    readonly dailyQuota = false,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type Fetcher = typeof fetch;

/**
 * Retry rate limits (429) and transient 5xx a few times, honouring retry-after when given. A 429
 * that asks for more than a minute (a daily quota, not a per-minute one) is returned at once:
 * waiting would only end in a vague timeout.
 */
async function withRetry(fn: () => Promise<Response>, sleep: (ms: number) => Promise<void>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fn();
    if ((res.status !== 429 && res.status < 500) || attempt >= 4) return res;
    const hint = Number(res.headers.get("retry-after"));
    if (res.status === 429 && Number.isFinite(hint) && hint > 60) return res;
    await sleep(Number.isFinite(hint) && hint > 0 ? Math.min(hint, 30) * 1000 : 2000 * 2 ** attempt);
  }
}

/** A short, secret-free reason for a refused call (e.g. Groq's "tokens per day" limit). */
async function refusal(provider: Provider, res: Response): Promise<LlmError> {
  const detail = await res.text().catch(() => "");
  const hint = Number(res.headers.get("retry-after"));
  const daily = /per day|TPD|RPD|PerDay/i.test(detail);
  const wait = Number.isFinite(hint) && hint > 0 ? `; retry in ~${Math.ceil(hint / 60)} min` : "";
  const reason = res.status === 429 ? ` (${daily ? "daily quota reached" : "rate limited"}${wait})` : "";
  return new LlmError(
    `${provider} HTTP ${res.status}${reason}`,
    res.status,
    res.status === 429 && daily,
    Number.isFinite(hint) && hint > 0 ? hint : undefined,
  );
}

/** Parse a comma-separated LLM_FALLBACK_MODELS setting. */
export const fallbackModelsOf = (setting: string | undefined): string[] =>
  (setting ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

/** provider:model → when its daily quota frees up again (epoch ms). Per process. */
const exhaustedUntil = new Map<string, number>();
const modelKey = (cfg: LlmConfig, model: string) => `${cfg.provider}:${model}`;

/** The first configured model whose daily quota is not known to be used up. */
export function activeModel(cfg: LlmConfig, now = Date.now()): string {
  return [cfg.model, ...(cfg.fallbackModels ?? [])].find((m) => (exhaustedUntil.get(modelKey(cfg, m)) ?? 0) <= now) ?? cfg.model;
}

/** Tests only: forget which models were marked as exhausted. */
export function resetQuotaState() {
  exhaustedUntil.clear();
}

/** One call, switching to the next fallback model when the current one's daily quota is used up. */
async function rawJson(cfg: LlmConfig, messages: ChatMessage[], fetcher: Fetcher, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<string> {
  for (;;) {
    const model = activeModel(cfg);
    try {
      return await rawOnce({ ...cfg, model }, messages, fetcher, sleep);
    } catch (err) {
      if (!(err instanceof LlmError) || !err.dailyQuota) throw err;
      exhaustedUntil.set(modelKey(cfg, model), Date.now() + (err.retryAfterS ?? 3600) * 1000);
      const next = activeModel(cfg);
      if (next === model) throw err;
      cfg.onFallback?.(model, next, err.message);
    }
  }
}
export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Free tiers limit requests per minute (Gemini's is small), so calls to a provider are spaced out
 * by a minimum interval instead of tripping 429s mid-trial.
 */
const MIN_INTERVAL_MS: Record<Provider, number> = { groq: 0, gemini: 7000, local: 0 };

export const LOCAL_DEFAULT_URL = "http://127.0.0.1:8080/v1";
/**
 * "local" talks to an OpenAI-compatible server on THIS machine (e.g. llama.cpp's llama-server).
 * Only loopback addresses are accepted, so a local model can never be pointed at a remote host.
 */
export function localEndpoint(baseUrl: string | undefined): string {
  const url = new URL(baseUrl ?? LOCAL_DEFAULT_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new LlmError(`local models must run on this machine (got ${url.hostname})`);
  return `${url.toString().replace(/\/+$/, "")}/chat/completions`;
}
const lastCallAt = new Map<string, number>();
async function pace(cfg: LlmConfig, sleep: (ms: number) => Promise<void>) {
  const gap = cfg.minIntervalMs ?? MIN_INTERVAL_MS[cfg.provider];
  const wait = (lastCallAt.get(cfg.provider) ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt.set(cfg.provider, Date.now());
}

async function rawOnce(cfg: LlmConfig, messages: ChatMessage[], fetcher: Fetcher, sleep: (ms: number) => Promise<void>): Promise<string> {
  await pace(cfg, sleep);
  // A fresh timeout per attempt: a retry must not inherit the time an earlier attempt used.
  // Local models on laptop hardware are slow, so they get more time.
  const timeoutMs = cfg.timeoutMs ?? (cfg.provider === "local" ? 300_000 : 60_000);
  if (cfg.provider === "groq" || cfg.provider === "local") {
    const url = cfg.provider === "local" ? localEndpoint(cfg.baseUrl) : "https://api.groq.com/openai/v1/chat/completions";
    const call = (jsonMode: boolean) =>
      withRetry(
        () =>
          fetcher(url, {
            method: "POST",
            headers: cfg.provider === "local" ? { "content-type": "application/json" } : { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: cfg.model, messages, temperature: 0, ...(jsonMode ? { response_format: { type: "json_object" } } : {}) }),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        sleep,
      );
    let res = await call(true);
    if (res.status === 400) {
      // Groq's JSON mode answers 400 (json_validate_failed) when the model's output is not valid
      // JSON. Ask again without JSON mode; the reply is still parsed and schema-validated below.
      const detail = await res.text().catch(() => "");
      if (!/json_validate_failed|json/i.test(detail)) throw new LlmError(`${cfg.provider} HTTP 400 (${detail.slice(0, 120)})`, 400);
      res = await call(false);
    }
    if (!res.ok) throw await refusal(cfg.provider, res);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  }
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const res = await withRetry(
    () =>
      fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents,
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    sleep,
  );
  if (!res.ok) throw await refusal("gemini", res);
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

/** Strip a ```json fence if a model adds one anyway. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return JSON.parse((fenced ? fenced[1]! : text).trim());
}

/**
 * Ask for JSON matching `schema`. One retry with the validation error fed back; then throws.
 */
export async function askJson<T>(
  cfg: LlmConfig,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  fetcher: Fetcher = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let convo = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = await rawJson(cfg, convo, fetcher, sleep);
    // An EMPTY answer means the model produced nothing usable. Ask again unchanged (a correction
    // prompt would push it to invent an action), and if it is still empty, fail loudly: the caller
    // records an error, which is never counted as a decision.
    if (text.trim() === "") text = await rawJson(cfg, convo, fetcher, sleep);
    if (text.trim() === "") throw new LlmError(`${cfg.provider} returned an empty response`);
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      convo = [...messages, { role: "assistant", content: text.slice(0, 2000) }, { role: "user", content: "That was not valid JSON. Reply with one JSON object only." }];
      continue;
    }
    const check = schema.safeParse(parsed);
    if (check.success) return check.data;
    convo = [
      ...messages,
      { role: "assistant", content: JSON.stringify(parsed).slice(0, 2000) },
      { role: "user", content: `That JSON did not match the required shape: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Reply with corrected JSON only.` },
    ];
  }
  throw new LlmError("model did not return valid JSON after a retry");
}
