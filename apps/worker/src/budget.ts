/** Per-run safety limits: request budget, time limit and a kill switch. */
export class RunStopped extends Error {
  constructor(readonly why: "budget" | "time" | "killed") {
    super(`run stopped: ${why}`);
    this.name = "RunStopped";
  }
}

export class RunBudget {
  used = 0;
  private killed = false;
  private readonly deadline: number;

  constructor(
    readonly maxRequests: number,
    maxMinutes: number,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.deadline = now() + maxMinutes * 60_000;
  }
  private readonly now: () => number;

  /** Call before every outgoing request. */
  spend(n = 1) {
    this.check();
    if (this.used + n > this.maxRequests) throw new RunStopped("budget");
    this.used += n;
  }

  check() {
    if (this.killed) throw new RunStopped("killed");
    if (this.now() > this.deadline) throw new RunStopped("time");
  }

  kill() {
    this.killed = true;
  }

  /** Poll `fn` until it returns a value, the wait runs out, or the run is stopped. */
  async waitFor<T>(fn: () => Promise<T | undefined>, opts: { seconds: number; everyMs?: number }): Promise<T | undefined> {
    const until = this.now() + opts.seconds * 1000;
    for (;;) {
      this.check();
      const v = await fn();
      if (v !== undefined) return v;
      if (this.now() >= until) return undefined;
      await new Promise((r) => setTimeout(r, opts.everyMs ?? 3000));
    }
  }
}
