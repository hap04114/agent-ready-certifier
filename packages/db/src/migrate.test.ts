import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, migrate } from "./index.js";
import { createTestDb } from "./testing.js";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.close());

describe("migrate", () => {
  it("applies each migration once, inside its schema", async () => {
    const migrations = [
      { id: "001", sql: "CREATE TABLE t (id int PRIMARY KEY);" },
      { id: "002", sql: "ALTER TABLE t ADD COLUMN name text;" },
    ];
    expect(await migrate(db, "app_x", migrations)).toEqual(["001", "002"]);
    expect(await migrate(db, "app_x", migrations)).toEqual([]);
    await db.query("INSERT INTO app_x.t (id, name) VALUES ($1, $2)", [1, "a"]);
    expect((await db.query("SELECT name FROM app_x.t")).rows).toEqual([{ name: "a" }]);
  });

  it("rolls back a failing migration", async () => {
    await expect(migrate(db, "app_y", [{ id: "001", sql: "CREATE TABLE t (id int); SELECT broken_syntax(;" }])).rejects.toThrow();
    expect((await db.query("SELECT count(*)::int AS n FROM app_y._migrations")).rows).toEqual([{ n: 0 }]);
  });

  it("rejects unsafe schema names", async () => {
    await expect(migrate(db, "x; DROP TABLE y", [])).rejects.toThrow("invalid schema name");
  });
});
