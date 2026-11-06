import { describe, expect, it } from "vitest";
import { RunBudget, RunStopped } from "./budget.js";

describe("RunBudget", () => {
  it("stops when the request budget is spent", () => {
    const b = new RunBudget(2, 10);
    b.spend();
    b.spend();
    expect(() => b.spend()).toThrow(RunStopped);
    expect(b.used).toBe(2);
  });

  it("stops after the time limit", () => {
    let t = 0;
    const b = new RunBudget(100, 1, () => t);
    b.spend();
    t = 61_000;
    expect(() => b.spend()).toThrow("run stopped: time");
  });

  it("kill switch stops immediately", () => {
    const b = new RunBudget(100, 10);
    b.kill();
    expect(() => b.check()).toThrow("run stopped: killed");
  });

  it("waitFor returns a value or gives up", async () => {
    const b = new RunBudget(100, 10);
    let n = 0;
    expect(await b.waitFor(async () => (++n >= 2 ? "ok" : undefined), { seconds: 5, everyMs: 1 })).toBe("ok");
    expect(await b.waitFor(async () => undefined, { seconds: 0, everyMs: 1 })).toBeUndefined();
  });
});
