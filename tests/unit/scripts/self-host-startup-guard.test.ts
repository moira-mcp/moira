import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "@jest/globals";

const guard = path.resolve("scripts/self-host-startup-guard.sh");
const entrypoint = path.resolve("scripts/container-entrypoint.sh");

function sqlite(db: string, statement: string): string {
  return execFileSync("sqlite3", [db, statement], { encoding: "utf8" }).trim();
}

function writeCommand(dir: string, body: string): string {
  const command = path.join(dir, "init.sh");
  fs.writeFileSync(command, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  return command;
}

function guardEnv(dir: string, db: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEPLOYMENT_MODE: "self-host",
    DB_PATH: db,
    MOIRA_INIT_SENTINEL_DIR: dir,
  };
}

async function waitForFile(file: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    if (child?.exitCode !== null) {
      throw new Error(`process exited before creating ${file}: ${child?.exitCode}`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

describe("self-host startup guard", () => {
  test("entrypoint clears stale sentinels before executing Supervisor's command", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-entrypoint-generation-"));
    try {
      fs.writeFileSync(path.join(dir, "init-success"), "stale");
      fs.writeFileSync(path.join(dir, "init-failed"), "stale");
      const observed = path.join(dir, "observed");
      const command = writeCommand(
        dir,
        `test ! -e "${dir}/init-success"\ntest ! -e "${dir}/init-failed"\ntouch "${observed}"`,
      );

      execFileSync(entrypoint, [command], {
        env: { ...process.env, MOIRA_INIT_SENTINEL_DIR: dir },
      });

      expect(fs.existsSync(observed)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("backs up existing state before allowing initialization to commit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-success-"));
    const db = path.join(dir, "moira.db");
    const manifest = path.join(dir, "prompt-manifest.json");
    try {
      sqlite(
        db,
        "PRAGMA journal_mode=WAL; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');",
      );
      fs.writeFileSync(manifest, '{"state":"before"}\n');
      const beforeDump = sqlite(db, ".dump");
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "UPDATE marker SET value='after';"\nprintf '%s\\n' '{"state":"after"}' > "$(dirname "$DB_PATH")/prompt-manifest.json"`,
      );

      execFileSync(guard, [command], { env: guardEnv(dir, db) });

      expect(sqlite(db, "SELECT value FROM marker;")).toBe("after");
      const backupDir = path.join(dir, ".moira-startup-backups", "current");
      const backup = path.join(backupDir, "moira.db");
      expect(sqlite(backup, ".dump")).toBe(beforeDump);
      expect(sqlite(backup, "PRAGMA integrity_check;")).toBe("ok");
      expect(fs.readFileSync(path.join(backupDir, "prompt-manifest.json"), "utf8")).toBe(
        '{"state":"before"}\n',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restores database and prompt manifest after partial initialization failure", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-failure-"));
    const db = path.join(dir, "moira.db");
    const manifest = path.join(dir, "prompt-manifest.json");
    try {
      sqlite(
        db,
        "PRAGMA journal_mode=WAL; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');",
      );
      fs.writeFileSync(manifest, '{"state":"before"}\n');
      const beforeDump = sqlite(db, ".dump");
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "UPDATE marker SET value='partial'; CREATE TABLE partial(id INTEGER);"\nprintf '%s\\n' '{"state":"partial"}' > "$(dirname "$DB_PATH")/prompt-manifest.json"\nexit 23`,
      );

      expect(() => execFileSync(guard, [command], { env: guardEnv(dir, db) })).toThrow();

      expect(sqlite(db, ".dump")).toBe(beforeDump);
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("before");
      expect(sqlite(db, "SELECT count(*) FROM sqlite_master WHERE name='partial';")).toBe("0");
      expect(sqlite(db, "PRAGMA integrity_check;")).toBe("ok");
      expect(fs.readFileSync(manifest, "utf8")).toBe('{"state":"before"}\n');
      expect(fs.existsSync(path.join(dir, "init-failed"))).toBe(true);
      expect(
        sqlite(
          path.join(dir, ".moira-startup-backups", "current", "moira.db"),
          "PRAGMA integrity_check;",
        ),
      ).toBe("ok");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes incomplete database state when the first initialization fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-first-failure-"));
    const db = path.join(dir, "moira.db");
    try {
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "CREATE TABLE partial(id INTEGER);"\nprintf '%s\\n' '{}' > "$(dirname "$DB_PATH")/prompt-manifest.json"\nexit 17`,
      );

      expect(() => execFileSync(guard, [command], { env: guardEnv(dir, db) })).toThrow();

      expect(fs.existsSync(db)).toBe(false);
      expect(fs.existsSync(`${db}-wal`)).toBe(false);
      expect(fs.existsSync(`${db}-shm`)).toBe(false);
      expect(fs.existsSync(path.join(dir, "prompt-manifest.json"))).toBe(false);
      expect(fs.existsSync(path.join(dir, ".moira-startup-backups"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retains exactly the three most recent pre-startup states", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-rotation-"));
    const db = path.join(dir, "moira.db");
    try {
      sqlite(db, "CREATE TABLE marker(value INTEGER); INSERT INTO marker VALUES(0);");
      const command = writeCommand(dir, `sqlite3 "$DB_PATH" "UPDATE marker SET value=value+1;"`);

      for (let run = 0; run < 4; run += 1) {
        execFileSync(guard, [command], { env: guardEnv(dir, db) });
        if (run === 0) {
          const current = path.join(dir, ".moira-startup-backups", "current", "moira.db");
          fs.writeFileSync(`${current}-wal`, "");
          fs.writeFileSync(`${current}-shm`, "");
        }
      }

      const stateDir = path.join(dir, ".moira-startup-backups");
      expect(sqlite(path.join(stateDir, "current", "moira.db"), "SELECT value FROM marker;")).toBe(
        "3",
      );
      expect(
        sqlite(path.join(stateDir, "previous-1", "moira.db"), "SELECT value FROM marker;"),
      ).toBe("2");
      expect(
        sqlite(path.join(stateDir, "previous-2", "moira.db"), "SELECT value FROM marker;"),
      ).toBe("1");
      expect(fs.readdirSync(stateDir).sort()).toEqual(["current", "previous-1", "previous-2"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers an interrupted initialization before protecting the next attempt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-interrupted-"));
    const db = path.join(dir, "moira.db");
    const manifest = path.join(dir, "prompt-manifest.json");
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      fs.writeFileSync(manifest, '{"state":"before"}\n');
      const noChange = writeCommand(dir, ":");
      execFileSync(guard, [noChange], { env: guardEnv(dir, db) });

      sqlite(db, "UPDATE marker SET value='partial'; CREATE TABLE crash_partial(id INTEGER);");
      fs.writeFileSync(manifest, '{"state":"partial"}\n');
      const current = path.join(dir, ".moira-startup-backups", "current");
      fs.writeFileSync(path.join(current, "initialization.pending"), "");
      const commit = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "UPDATE marker SET value='committed';"\nprintf '%s\\n' '{"state":"committed"}' > "$(dirname "$DB_PATH")/prompt-manifest.json"`,
      );

      execFileSync(guard, [commit], { env: guardEnv(dir, db) });

      expect(sqlite(db, "SELECT value FROM marker;")).toBe("committed");
      expect(sqlite(db, "SELECT count(*) FROM sqlite_master WHERE name='crash_partial';")).toBe(
        "0",
      );
      expect(sqlite(path.join(current, "moira.db"), "SELECT value FROM marker;")).toBe("before");
      expect(fs.readFileSync(path.join(current, "prompt-manifest.json"), "utf8")).toBe(
        '{"state":"before"}\n',
      );
      expect(fs.existsSync(path.join(current, "initialization.pending"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes an interrupted first start before retrying from empty state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-interrupted-first-"));
    const db = path.join(dir, "moira.db");
    try {
      sqlite(db, "CREATE TABLE partial(id INTEGER);");
      fs.writeFileSync(path.join(dir, "prompt-manifest.json"), '{"state":"partial"}\n');
      const firstStart = path.join(dir, ".moira-startup-backups", "first-start");
      fs.mkdirSync(firstStart, { recursive: true });
      fs.writeFileSync(path.join(firstStart, "first-start.pending"), "");
      fs.writeFileSync(path.join(firstStart, "prompt-manifest.absent"), "");
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('clean');"`,
      );

      execFileSync(guard, [command], { env: guardEnv(dir, db) });

      expect(sqlite(db, "SELECT value FROM marker;")).toBe("clean");
      expect(sqlite(db, "SELECT count(*) FROM sqlite_master WHERE name='partial';")).toBe("0");
      expect(fs.existsSync(path.join(dir, "prompt-manifest.json"))).toBe(false);
      expect(fs.existsSync(firstStart)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clears a stale success sentinel before backup and initialization", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-stale-sentinel-"));
    const db = path.join(dir, "moira.db");
    const ready = path.join(dir, "ready");
    const release = path.join(dir, "release");
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      fs.writeFileSync(path.join(dir, "init-success"), "stale");
      const command = writeCommand(
        dir,
        `touch "${ready}"\nwhile [ ! -f "${release}" ]; do sleep 0.05; done`,
      );
      const child = spawn(guard, [command], { env: guardEnv(dir, db), stdio: "ignore" });

      await waitForFile(ready, child);
      expect(fs.existsSync(path.join(dir, "init-success"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "init-failed"))).toBe(false);
      fs.writeFileSync(release, "");
      expect(await waitForExit(child)).toBe(0);
      expect(fs.existsSync(path.join(dir, "init-success"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publishes failure only after a blocked restore becomes observable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-failure-order-"));
    const db = path.join(dir, "moira.db");
    const manifest = path.join(dir, "prompt-manifest.json");
    const blocked = path.join(dir, "restore-blocked");
    const release = path.join(dir, "restore-release");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      fs.writeFileSync(manifest, '{"state":"before"}\n');
      const realCp = execFileSync("sh", ["-c", "command -v cp"], { encoding: "utf8" }).trim();
      fs.writeFileSync(
        path.join(bin, "cp"),
        `#!/bin/sh\ncase "$1" in */.moira-startup-backups/current/moira.db) touch "$RESTORE_BLOCKED"; while [ ! -f "$RESTORE_RELEASE" ]; do sleep 0.05; done ;; esac\nexec "${realCp}" "$@"\n`,
        { mode: 0o755 },
      );
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "UPDATE marker SET value='partial';"\nprintf '%s\\n' '{"state":"partial"}' > "$(dirname "$DB_PATH")/prompt-manifest.json"\nexit 29`,
      );
      const child = spawn(guard, [command], {
        env: {
          ...guardEnv(dir, db),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RESTORE_BLOCKED: blocked,
          RESTORE_RELEASE: release,
        },
        stdio: "ignore",
      });

      await waitForFile(blocked, child);
      expect(fs.existsSync(path.join(dir, "init-failed"))).toBe(false);
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("partial");
      fs.writeFileSync(release, "");
      expect(await waitForExit(child)).toBe(29);
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("before");
      expect(fs.readFileSync(manifest, "utf8")).toBe('{"state":"before"}\n');
      expect(fs.existsSync(path.join(dir, "init-failed"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps first-start recovery when incomplete data cannot be removed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-remove-fault-"));
    const sentinels = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-remove-sentinel-"));
    const db = path.join(dir, "moira.db");
    try {
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "CREATE TABLE partial(id INTEGER);"\nchmod 500 "$(dirname "$DB_PATH")"\nexit 31`,
      );
      expect(() =>
        execFileSync(guard, [command], {
          env: { ...guardEnv(sentinels, db), MOIRA_INIT_SENTINEL_DIR: sentinels },
        }),
      ).toThrow();

      fs.chmodSync(dir, 0o700);
      expect(fs.existsSync(db)).toBe(true);
      expect(
        fs.existsSync(
          path.join(dir, ".moira-startup-backups", "first-start", "first-start.pending"),
        ),
      ).toBe(true);
      expect(fs.existsSync(path.join(sentinels, "init-failed"))).toBe(true);
      const retry = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('clean');"`,
      );
      execFileSync(guard, [retry], {
        env: { ...guardEnv(sentinels, db), MOIRA_INIT_SENTINEL_DIR: sentinels },
      });
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("clean");
      expect(sqlite(db, "SELECT count(*) FROM sqlite_master WHERE name='partial';")).toBe("0");
    } finally {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(sentinels, { recursive: true, force: true });
    }
  });

  test("never publishes success when the pending marker cannot commit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-marker-fault-"));
    const db = path.join(dir, "moira.db");
    const current = path.join(dir, ".moira-startup-backups", "current");
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      const command = writeCommand(dir, `chmod 500 "${current}"`);
      expect(() => execFileSync(guard, [command], { env: guardEnv(dir, db) })).toThrow();

      fs.chmodSync(current, 0o700);
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("before");
      expect(fs.existsSync(path.join(current, "initialization.pending"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "init-success"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "init-failed"))).toBe(true);
      const retry = writeCommand(dir, `sqlite3 "$DB_PATH" "UPDATE marker SET value='after';"`);
      execFileSync(guard, [retry], { env: guardEnv(dir, db) });
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("after");
    } finally {
      if (fs.existsSync(current)) fs.chmodSync(current, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restores data when the success sentinel cannot be published", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-sentinel-fault-"));
    const sentinels = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-sentinel-dir-"));
    const db = path.join(dir, "moira.db");
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      fs.chmodSync(sentinels, 0o500);
      const command = writeCommand(dir, `sqlite3 "$DB_PATH" "UPDATE marker SET value='partial';"`);
      expect(() =>
        execFileSync(guard, [command], {
          env: { ...guardEnv(sentinels, db), MOIRA_INIT_SENTINEL_DIR: sentinels },
        }),
      ).toThrow();

      expect(sqlite(db, "SELECT value FROM marker;")).toBe("before");
      expect(fs.existsSync(path.join(sentinels, "init-success"))).toBe(false);
      fs.chmodSync(sentinels, 0o700);
      const retry = writeCommand(dir, `sqlite3 "$DB_PATH" "UPDATE marker SET value='after';"`);
      execFileSync(guard, [retry], {
        env: { ...guardEnv(sentinels, db), MOIRA_INIT_SENTINEL_DIR: sentinels },
      });
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("after");
    } finally {
      fs.chmodSync(sentinels, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(sentinels, { recursive: true, force: true });
    }
  });

  test("retains recovery state when prompt-manifest restore is faulted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-manifest-fault-"));
    const db = path.join(dir, "moira.db");
    const manifest = path.join(dir, "prompt-manifest.json");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      fs.writeFileSync(manifest, '{"state":"before"}\n');
      const realCp = execFileSync("sh", ["-c", "command -v cp"], { encoding: "utf8" }).trim();
      fs.writeFileSync(
        path.join(bin, "cp"),
        `#!/bin/sh\ncase "$2" in */.moira-manifest-restore.*) exit 47 ;; esac\nexec "${realCp}" "$@"\n`,
        { mode: 0o755 },
      );
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "UPDATE marker SET value='partial';"\nprintf '%s\\n' '{"state":"partial"}' > "$(dirname "$DB_PATH")/prompt-manifest.json"\nexit 41`,
      );
      expect(() =>
        execFileSync(guard, [command], {
          env: { ...guardEnv(dir, db), PATH: `${bin}:${process.env.PATH ?? ""}` },
        }),
      ).toThrow();

      const current = path.join(dir, ".moira-startup-backups", "current");
      expect(fs.existsSync(path.join(current, "initialization.pending"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "init-success"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "init-failed"))).toBe(true);
      const retry = writeCommand(dir, ":");
      execFileSync(guard, [retry], { env: guardEnv(dir, db) });
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("before");
      expect(fs.readFileSync(manifest, "utf8")).toBe('{"state":"before"}\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed for stale staging symlinks without writing outside state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-staging-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-staging-outside-"));
    const db = path.join(dir, "moira.db");
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      const stateDir = path.join(dir, ".moira-startup-backups");
      fs.mkdirSync(stateDir);
      fs.symlinkSync(outside, path.join(stateDir, ".next.attack"));
      const command = writeCommand(dir, `sqlite3 "$DB_PATH" "UPDATE marker SET value='after';"`);

      expect(() => execFileSync(guard, [command], { env: guardEnv(dir, db) })).toThrow();

      expect(sqlite(db, "SELECT value FROM marker;")).toBe("before");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects stale database-restore symlinks before interrupted-state recovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-db-restore-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-db-restore-outside-"));
    const db = path.join(dir, "moira.db");
    const target = path.join(outside, "target");
    const suspicious = path.join(dir, ".moira-db-restore.attack");
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      const noChange = writeCommand(dir, ":");
      execFileSync(guard, [noChange], { env: guardEnv(dir, db) });
      sqlite(db, "UPDATE marker SET value='partial';");
      const current = path.join(dir, ".moira-startup-backups", "current");
      fs.writeFileSync(path.join(current, "initialization.pending"), "");
      fs.writeFileSync(target, "outside");
      fs.symlinkSync(target, suspicious);

      expect(() => execFileSync(guard, [noChange], { env: guardEnv(dir, db) })).toThrow();

      expect(fs.readFileSync(target, "utf8")).toBe("outside");
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("partial");
      fs.unlinkSync(suspicious);
      execFileSync(guard, [noChange], { env: guardEnv(dir, db) });
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("before");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("rejects stale manifest-restore symlinks before interrupted first-start recovery", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-manifest-symlink-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-manifest-outside-"));
    const db = path.join(dir, "moira.db");
    const target = path.join(outside, "target");
    const suspicious = path.join(dir, ".moira-manifest-restore.attack");
    try {
      sqlite(db, "CREATE TABLE partial(id INTEGER);");
      const firstStart = path.join(dir, ".moira-startup-backups", "first-start");
      fs.mkdirSync(firstStart, { recursive: true });
      fs.writeFileSync(path.join(firstStart, "first-start.pending"), "");
      fs.writeFileSync(path.join(firstStart, "prompt-manifest.json"), '{"state":"before"}\n');
      fs.writeFileSync(target, "outside");
      fs.symlinkSync(target, suspicious);
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('clean');"`,
      );

      expect(() => execFileSync(guard, [command], { env: guardEnv(dir, db) })).toThrow();

      expect(fs.readFileSync(target, "utf8")).toBe("outside");
      expect(sqlite(db, "SELECT count(*) FROM sqlite_master WHERE name='partial';")).toBe("1");
      fs.unlinkSync(suspicious);
      execFileSync(guard, [command], { env: guardEnv(dir, db) });
      expect(sqlite(db, "SELECT count(*) FROM sqlite_master WHERE name='partial';")).toBe("0");
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("clean");
      expect(fs.readFileSync(path.join(dir, "prompt-manifest.json"), "utf8")).toBe(
        '{"state":"before"}\n',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("removes stale real staging directories before creating a fresh backup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-stale-staging-"));
    const db = path.join(dir, "moira.db");
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      const stale = path.join(dir, ".moira-startup-backups", ".next.dead");
      fs.mkdirSync(stale, { recursive: true });
      fs.writeFileSync(path.join(stale, "moira.db.tmp.42"), "partial");
      const command = writeCommand(dir, `sqlite3 "$DB_PATH" "UPDATE marker SET value='after';"`);

      execFileSync(guard, [command], { env: guardEnv(dir, db) });

      expect(fs.existsSync(stale)).toBe(false);
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("after");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleans SIGKILL staging left during backup before retry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-backup-kill-"));
    const db = path.join(dir, "moira.db");
    const blocked = path.join(dir, "backup-blocked");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      const realSqlite = execFileSync("sh", ["-c", "command -v sqlite3"], {
        encoding: "utf8",
      }).trim();
      fs.writeFileSync(
        path.join(bin, "sqlite3"),
        `#!/bin/sh\ncase "$*" in *".backup "*) touch "$BACKUP_BLOCKED"; while :; do sleep 1; done ;; esac\nexec "${realSqlite}" "$@"\n`,
        { mode: 0o755 },
      );
      const command = writeCommand(dir, ":");
      const child = spawn(guard, [command], {
        detached: true,
        env: {
          ...guardEnv(dir, db),
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          BACKUP_BLOCKED: blocked,
        },
        stdio: "ignore",
      });
      await waitForFile(blocked, child);

      process.kill(-(child.pid as number), "SIGKILL");
      await waitForExit(child);
      const stateDir = path.join(dir, ".moira-startup-backups");
      expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".next."))).toBe(true);
      execFileSync(guard, [command], { env: guardEnv(dir, db) });
      expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".next."))).toBe(false);
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("before");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restores state and publishes failure when terminated during mutation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-sigterm-"));
    const db = path.join(dir, "moira.db");
    const ready = path.join(dir, "ready");
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "UPDATE marker SET value='partial';"\ntouch "${ready}"\ntrap 'exit 143' TERM INT HUP\nwhile :; do sleep 1; done`,
      );
      const child = spawn(guard, [command], { env: guardEnv(dir, db), stdio: "ignore" });
      await waitForFile(ready, child);

      child.kill("SIGTERM");
      expect(await waitForExit(child)).not.toBe(0);
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("before");
      expect(fs.existsSync(path.join(dir, "init-failed"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "init-success"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers on retry after process-group SIGKILL during mutation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moira-startup-sigkill-"));
    const db = path.join(dir, "moira.db");
    const ready = path.join(dir, "ready");
    try {
      sqlite(db, "CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
      const command = writeCommand(
        dir,
        `sqlite3 "$DB_PATH" "UPDATE marker SET value='partial'; CREATE TABLE crash_partial(id INTEGER);"\ntouch "${ready}"\nwhile :; do sleep 1; done`,
      );
      const child = spawn(guard, [command], {
        detached: true,
        env: guardEnv(dir, db),
        stdio: "ignore",
      });
      await waitForFile(ready, child);

      process.kill(-(child.pid as number), "SIGKILL");
      await waitForExit(child);
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("partial");
      const retry = writeCommand(dir, `sqlite3 "$DB_PATH" "UPDATE marker SET value='after';"`);
      execFileSync(guard, [retry], { env: guardEnv(dir, db) });
      expect(sqlite(db, "SELECT value FROM marker;")).toBe("after");
      expect(sqlite(db, "SELECT count(*) FROM sqlite_master WHERE name='crash_partial';")).toBe(
        "0",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
