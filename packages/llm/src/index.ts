/**
 * Minimal JSON-only LLM client for two providers (Groq, Gemini).
 * Every call returns JSON validated against a zod schema (CLAUDE.md rule 6). Free text never
 * leaves this module. Keys come from the caller; they are never logged.
 */
import type { z } from "zod";

export type Provider = "groq" | "gemini";

export interface LlmConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type Fetcher = typeof fetch;

async function rawJson(cfg: LlmConfig, messages: ChatMessage[], fetcher: Fetcher): Promise<string> {
  const signal = AbortSignal.timeout(cfg.timeoutMs ?? 60_000);
  if (cfg.provider === "groq") {
    const res = await fetcher("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0, response_format: { type: "json_object" } }),
      signal,
    });
    if (!res.ok) throw new LlmError(`groq HTTP ${res.status}`, res.status);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  }
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents,
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
    signal,
  });
  if (!res.ok) throw new LlmError(`gemini HTTP ${res.status}`, res.status);
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
export async function askJson<T>(cfg: LlmConfig, messages: ChatMessage[], schema: z.ZodType<T>, fetcher: Fetcher = fetch): Promise<T> {
  let convo = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await rawJson(cfg, convo, fetcher);
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
