import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "@jest/globals";

const script = path.resolve(process.cwd(), "scripts/sqlite-online-backup.sh");

describe("SQLite online backup", () => {
  test("checks free space and destination permissions before backup", () => {
    const source = fs.readFileSync(script, "utf8");
    expect(source).toContain("insufficient free space for backup");
    expect(source).toContain("destination directory is not writable");
    expect(source).toContain(".timeout 5000");
  });

  test("captures one coherent state while WAL writes continue", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-online-backup-"));
    const source = path.join(dir, "source.db");
    const backup = path.join(dir, "backup.db");
    const writerReady = path.join(dir, "writer-ready");
    try {
      execFileSync("sqlite3", [
        source,
        "PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY); CREATE TABLE totals(value INTEGER NOT NULL); INSERT INTO items VALUES(1); INSERT INTO totals VALUES(1);",
      ]);
      const writer = spawn("sh", [
        "-c",
        `{ printf '%s\n' 'BEGIN IMMEDIATE;' 'INSERT INTO items VALUES(2);' 'UPDATE totals SET value=value+1;' ".shell touch '${writerReady}'"; sleep 1; printf '%s\n' 'COMMIT;'; i=3; while [ $i -le 150 ]; do printf '%s\n' "BEGIN IMMEDIATE; INSERT INTO items VALUES($i); UPDATE totals SET value=value+1; COMMIT;"; i=$((i+1)); done; } | sqlite3 '${source}'`,
      ]);
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (fs.existsSync(writerReady)) resolve();
          else if (Date.now() >= deadline) reject(new Error("writer did not start"));
          else setTimeout(poll, 10);
        };
        poll();
      });
      execFileSync(script, [source, backup]);
      await new Promise<void>((resolve, reject) => {
        writer.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${code}`))));
        writer.on("error", reject);
      });
      expect(
        execFileSync("sqlite3", [backup, "PRAGMA integrity_check;"], { encoding: "utf8" }).trim(),
      ).toBe("ok");
      const state = execFileSync(
        "sqlite3",
        [backup, "SELECT value || ':' || (SELECT count(*) FROM items) FROM totals;"],
        { encoding: "utf8" },
      ).trim();
      const [total, rows] = state.split(":").map(Number);
      expect(total).toBe(rows);
      expect(total).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed for a missing source", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-online-backup-missing-"));
    try {
      expect(() =>
        execFileSync(script, [path.join(dir, "missing.db"), path.join(dir, "backup.db")]),
      ).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a corrupt source without publishing a backup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-online-backup-corrupt-"));
    const source = path.join(dir, "corrupt.db");
    const backup = path.join(dir, "backup.db");
    try {
      fs.writeFileSync(source, "not a sqlite database");
      expect(() => execFileSync(script, [source, backup])).toThrow();
      expect(fs.existsSync(backup)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails before backup when the destination directory is not writable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-online-backup-permission-"));
    const source = path.join(dir, "source.db");
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked);
    execFileSync("sqlite3", [source, "CREATE TABLE value(id INTEGER);"]);
    fs.chmodSync(locked, 0o500);
    try {
      expect(() => execFileSync(script, [source, path.join(locked, "backup.db")])).toThrow();
    } finally {
      fs.chmodSync(locked, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
