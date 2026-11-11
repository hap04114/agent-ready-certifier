import { describe, expect, it } from "vitest";
import { contextMaticToken } from "./contextmatic.js";

function capture(seen: URLSearchParams[]): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    seen.push(new URLSearchParams(String(init.body)));
    return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("contextMaticToken", () => {
  it("asks for a client-credentials token as a public client (no secret sent)", async () => {
    const seen: URLSearchParams[] = [];
    expect(await contextMaticToken({ clientId: "c" }, capture(seen))).toBe("t");
    expect(seen[0]!.get("grant_type")).toBe("client_credentials");
    expect(seen[0]!.get("client_id")).toBe("c");
    expect(seen[0]!.has("client_secret")).toBe(false);
  });

  it("sends the secret when the server issued one", async () => {
    const seen: URLSearchParams[] = [];
    await contextMaticToken({ clientId: "c", clientSecret: "s" }, capture(seen));
    expect(seen[0]!.get("client_secret")).toBe("s");
  });

  it("reports a refusal without echoing credentials", async () => {
    const f = (async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })) as unknown as typeof fetch;
    await expect(contextMaticToken({ clientId: "c", clientSecret: "s" }, f)).rejects.toThrow(/^ContextMatic token refused \(HTTP 401, invalid_client\)$/);
  });
});
