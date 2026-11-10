import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmError, askJson, extractJson } from "./index.js";

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

  it("extracts JSON from a fenced block", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});
