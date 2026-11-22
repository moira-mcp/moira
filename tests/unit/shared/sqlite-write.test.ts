import { expect, test } from "@jest/globals";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { withSqliteWrite } from "../../../packages/shared/src/database/sqlite-write.js";

test("waits for another process without blocking its release or replaying a failed write", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "moira-writer-"));
  const file = path.join(folder, "test-writers.sqlite");
  const sqlite = new Database(file);
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
