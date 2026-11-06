/** Test helper: an in-process Postgres (PGlite) behind the same Db interface. */
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "./index.js";

export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.waitReady;
  let queue: Promise<unknown> = Promise.resolve();
  // PGlite is single-connection; serialize transactions so they cannot interleave.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const base = {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await pg.query<T>(sql, params as unknown[] | undefined);
      return { rows: res.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
  };
  const db: Db = {
    ...base,
    transaction: (fn) =>
      serial(() =>
        pg.transaction(async (t) => {
          const tx: Db = {
            async query<T>(sql: string, params?: unknown[]) {
              const res = await t.query<T>(sql, params as unknown[] | undefined);
              return { rows: res.rows };
            },
            async exec(sql: string) {
              await t.exec(sql);
            },
            transaction: (f) => f(tx),
            close: async () => {},
          };
          return fn(tx);
        }),
      ),
    close: () => pg.close(),
  };
  return db;
}
