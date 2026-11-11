import { describe, expect, it } from "vitest";
import { withTimeout } from "./kernel.js";

describe("withTimeout", () => {
  it("passes a fast result through", async () => {
    expect(await withTimeout(Promise.resolve(7), 1_000)).toBe(7);
  });

  it("gives up on work that never finishes, instead of waiting forever", async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 20)).rejects.toThrow("timed out after 0 s");
  });

  it("keeps the original error when the work fails first", async () => {
    await expect(withTimeout(Promise.reject(new Error("browser closed")), 1_000)).rejects.toThrow("browser closed");
  });
});
