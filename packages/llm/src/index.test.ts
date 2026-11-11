import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmError, activeModel, askJson, extractJson, resetQuotaState } from "./index.js";

beforeEach(() => resetQuotaState());

const schema = z.object({ action: z.enum(["click", "done"]), element: z.number().int().optional() });
const groq = { provider: "groq" as const, model: "m", apiKey: "k" };

function fakeFetch(replies: string[], seen: { url: string; body: unknown }[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    const content = replies.shift() ?? "{}";
    const payload = url.includes("groq")
      ? { choices: [{ message: { content } }] }
      : { candidates: [{ content: { parts: [{ text: content }] } }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("askJson", () => {
  it("returns schema-valid JSON", async () => {
    expect(await askJson(groq, [{ role: "user", content: "go" }], schema, fakeFetch(['{"action":"click","element":3}']))).toEqual({ action: "click", element: 3 });
  });

  it("retries once with the validation error, then succeeds", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const out = await askJson(groq, [{ role: "user", content: "go" }], schema, fakeFetch(['{"action":"jump"}', '{"action":"done"}'], seen));
    expect(out).toEqual({ action: "done" });
    const second = seen[1]!.body as { messages: { content: string }[] };
    expect(second.messages.at(-1)!.content).toMatch(/did not match the required shape: action/);
  });

  it("throws after two invalid replies (free text never flows on)", async () => {
    await expect(askJson(groq, [{ role: "user", content: "go" }], schema, fakeFetch(["sure, I will click", "ok"]))).rejects.toThrow(LlmError);
  });

  it("speaks Gemini's format, with the system prompt as systemInstruction", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const gem = { provider: "gemini" as const, model: "gemini-x", apiKey: "k" };
    await askJson(gem, [{ role: "system", content: "rules" }, { role: "user", content: "go" }], schema, fakeFetch(['{"action":"done"}'], seen));
    expect(seen[0]!.url).toContain("models/gemini-x:generateContent");
    expect(seen[0]!.body).toMatchObject({ systemInstruction: { parts: [{ text: "rules" }] }, contents: [{ role: "user", parts: [{ text: "go" }] }] });
  });

  it("waits and retries on a 429 rate limit", async () => {
    let calls = 0;
    const waits: number[] = [];
    const f = (async () => {
      calls++;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "3" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"done"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await askJson(groq, [{ role: "user", content: "go" }], schema, f, async (ms) => void waits.push(ms))).toEqual({ action: "done" });
    expect(waits).toEqual([3000]);
  });

  it("retries once without JSON mode when Groq rejects malformed JSON (400)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return new Response('{"error":{"code":"json_validate_failed"}}', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"done"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await askJson(groq, [{ role: "user", content: "go" }], schema, f, async () => {})).toEqual({ action: "done" });
    expect(bodies[0]).toHaveProperty("response_format");
    expect(bodies[1]).not.toHaveProperty("response_format");
  });

  it("gives up on persistent rate limits", async () => {
    const f = (async () => new Response("no", { status: 429 })) as unknown as typeof fetch;
    await expect(askJson(groq, [{ role: "user", content: "go" }], schema, f, async () => {})).rejects.toThrow("groq HTTP 429");
  });

  it("fails fast with a clear reason when a daily quota is reached (no long wait, no vague timeout)", async () => {
    let calls = 0;
    const waits: number[] = [];
    const f = (async () => {
      calls++;
      return new Response('{"error":{"message":"Rate limit reached ... on tokens per day (TPD): Limit 200000, Used 199222"}}', { status: 429, headers: { "retry-after": "809" } });
    }) as unknown as typeof fetch;
    await expect(askJson(groq, [{ role: "user", content: "go" }], schema, f, async (ms) => void waits.push(ms))).rejects.toThrow("groq HTTP 429 (daily quota reached; retry in ~14 min)");
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("switches to the next fallback model when a model's DAILY quota is used up, and reports it", async () => {
    const models: string[] = [];
    const switches: string[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      const model = (JSON.parse(String(init.body)) as { model: string }).model;
      models.push(model);
      if (model === "big") return new Response('{"error":{"message":"... tokens per day (TPD) ..."}}', { status: 429, headers: { "retry-after": "600" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"done"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = { ...groq, model: "big", fallbackModels: ["small"], onFallback: (from: string, to: string) => void switches.push(`${from}->${to}`) };
    expect(await askJson(cfg, [{ role: "user", content: "go" }], schema, f, async () => {})).toEqual({ action: "done" });
    expect(models).toEqual(["big", "small"]);
    expect(switches).toEqual(["big->small"]);
    // The exhausted model is skipped from now on (no wasted call).
    expect(activeModel(cfg)).toBe("small");
    await askJson(cfg, [{ role: "user", content: "go" }], schema, f, async () => {});
    expect(models).toEqual(["big", "small", "small"]);
  });

  it("does not switch models on a per-minute limit (it waits instead)", async () => {
    let calls = 0;
    const f = (async (_url: string, init: RequestInit) => {
      calls++;
      const model = (JSON.parse(String(init.body)) as { model: string }).model;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: `{"action":"done","element":${model === "big" ? 1 : 2}}` } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await askJson({ ...groq, model: "big", fallbackModels: ["small"] }, [{ role: "user", content: "go" }], schema, f, async () => {});
    expect(out).toEqual({ action: "done", element: 1 });
  });

  it("treats a twice-empty answer as an error, never as a nudged guess", async () => {
    const seen: { url: string; body: unknown }[] = [];
    await expect(askJson(groq, [{ role: "user", content: "go" }], schema, fakeFetch(["", ""], seen), async () => {})).rejects.toThrow("groq returned an empty response");
    // The second request is the SAME conversation, with no correction prompt added.
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body).toEqual(seen[1]!.body);
  });

  it("recovers when only the first answer is empty", async () => {
    expect(await askJson(groq, [{ role: "user", content: "go" }], schema, fakeFetch(["", '{"action":"done"}']), async () => {})).toEqual({ action: "done" });
  });

  it("extracts JSON from a fenced block", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});
