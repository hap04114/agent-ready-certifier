/**
 * Minimal Postgres access shared by the certifier and the demo stores.
 * Runtime uses node-postgres against DATABASE_URL; tests use PGlite (real Postgres in WASM).
 */
import pg from "pg";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Run fn inside a transaction on a single connection. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface Migration {
  id: string;
  sql: string;
}

/** Connect with node-postgres. The URL is never logged. */
export function createPgDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  pool.on("error", () => {
    // Idle-client errors would otherwise crash the process; queries surface their own errors.
  });
  const wrap = (client: pg.Pool | pg.PoolClient): Omit<Db, "transaction" | "close"> => ({
    async query(sql, params) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return { rows: res.rows };
    },
    async exec(sql) {
      await client.query(sql);
    },
  });
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: Db = { ...wrap(client), transaction: (f) => f(tx), close: async () => {} };
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Apply migrations in order inside `schema`, once each. Tracks applied IDs in
 * <schema>._migrations. Safe to run on every boot.
 */
export async function migrate(db: Db, schema: string, migrations: readonly Migration[]): Promise<string[]> {
  if (!IDENT.test(schema)) throw new Error("invalid schema name");
  await db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}; CREATE TABLE IF NOT EXISTS ${schema}._migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`);
  const applied = new Set((await db.query<{ id: string }>(`SELECT id FROM ${schema}._migrations`)).rows.map((r) => r.id));
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL search_path TO ${schema}; ${m.sql}`);
      await tx.query(`INSERT INTO ${schema}._migrations (id) VALUES ($1)`, [m.id]);
    });
    ran.push(m.id);
  }
  return ran;
}
export * from "./certifier.js";
