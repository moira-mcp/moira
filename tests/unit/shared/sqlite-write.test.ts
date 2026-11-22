import { expect, test, jest } from "@jest/globals";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  asSqliteWriter,
  ownsSqliteWriter,
  withSqliteWrite,
} from "../../../packages/shared/src/database/sqlite-write.js";
import { exposePrivateMemory } from "../../../packages/shared/src/database/private-memory.js";
import { getAuthKysely } from "../../../packages/shared/src/auth/sqlite-dialect.js";
import { sql as kyselySql } from "kysely";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("waits for another process without blocking its release or replaying a failed write", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "moira-writer-"));
  const file = path.join(folder, "test-writers.sqlite");
  const sqlite = new Database(file);
  const serialized = jest.spyOn(sqlite, "serialize");
  sqlite.exec("CREATE TABLE entries (value TEXT)");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const db=new (require("better-sqlite3"))(process.argv[1]);
    db.exec("BEGIN IMMEDIATE; INSERT INTO entries VALUES ('other process')");
    process.on("message",()=>{db.exec("COMMIT");db.close();process.disconnect();});
    process.send("holding");
  `,
      file,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  try {
    await once(child, "message");
    let calls = 0;
    const pending = withSqliteWrite(() => {
      calls++;
      sqlite.prepare("INSERT INTO entries VALUES (?)").run("rolled back");
      throw new Error("work failed");
    }, sqlite);
    const exit = once(child, "exit");
    setImmediate(() => child.send("release"));
    await expect(pending).rejects.toThrow("work failed");
    expect(calls).toBe(1);
    expect(await exit).toEqual([0, null]);
    await getAuthKysely(sqlite)
      .transaction()
      .execute((tx) => kyselySql`SELECT 1`.execute(tx));
    expect(serialized).not.toHaveBeenCalled();
    await withSqliteWrite(
      () => sqlite.prepare("INSERT INTO entries VALUES (?)").run("next writer"),
      sqlite,
    );
    expect(sqlite.prepare("SELECT value FROM entries ORDER BY rowid").pluck().all()).toEqual([
      "other process",
      "next writer",
    ]);
  } finally {
    if (child.exitCode === null) child.kill();
    sqlite.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("held memory handles read committed rows while the native owner writes and rolls back", async () => {
  const live = new Database(":memory:");
  const serialized = jest.spyOn(live, "serialize");
  const handles = exposePrivateMemory(
    live,
    () => ownsSqliteWriter(live),
    (db) => {
      expect(db.memory).toBe(true);
      expect(db.pragma("database_list")).toEqual([{ seq: 0, name: "main", file: "" }]);
    },
  );
  const app = drizzle(handles);
  handles.exec(
    "CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO sample VALUES(1,'committed'),(2,'second')",
  );
  const cached = handles.prepare("SELECT value FROM sample WHERE id=?").bind(1).pluck();
  const all = handles.prepare("SELECT value FROM sample ORDER BY id").pluck();
  const entered = signal();
  const finish = signal();
  const auth = getAuthKysely(live);
  const operation = auth.transaction().execute((tx) =>
    asSqliteWriter(live, async () => {
      await kyselySql`UPDATE sample SET value='in progress' WHERE id=1`.execute(tx);
      expect(cached.get()).toBe("in progress");
      entered.resolve();
      await finish.promise;
      throw new Error("abort registration");
    }),
  );
  try {
    await Promise.race([entered.promise, operation]);
    const iterator = all.iterate();
    expect(iterator.next().value).toBe("committed");
    expect(cached.get()).toBe("committed");
    expect(app.get<{ value: string }>(sql`SELECT value FROM sample WHERE id=1`)).toEqual({
      value: "committed",
    });
    let called = 0;
    const queued = withSqliteWrite(() => {
      called++;
      handles.prepare("INSERT INTO sample VALUES(3,'after rollback')").run();
    }, handles);
    finish.resolve();
    await expect(operation).rejects.toThrow("abort registration");
    await queued;
    expect([...iterator]).toEqual(["second"]);
    expect(all.all()).toEqual(["committed", "second", "after rollback"]);
    expect(called).toBe(1);
    expect(serialized).toHaveBeenCalledTimes(1);
  } finally {
    finish.resolve();
    live.close();
  }
});
