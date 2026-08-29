import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

describe("self-host upgrade contract", () => {
  const script = readFileSync(resolve("scripts/self-host-upgrade.sh"), "utf8");
  const startupGuard = readFileSync(resolve("scripts/self-host-startup-guard.sh"), "utf8");
  const compose = readFileSync(resolve("docker-compose.yml"), "utf8");
  const supervisor = readFileSync(resolve("config/supervisord.conf"), "utf8");
  const entrypoint = readFileSync(resolve("scripts/container-entrypoint.sh"), "utf8");
  const gitignore = readFileSync(resolve(".gitignore"), "utf8");
  const dockerignore = readFileSync(resolve(".dockerignore"), "utf8");

  test("uses latest for quickstart and guards self-host initialization inside the image", () => {
    expect(compose).toContain("${MOIRA_IMAGE:-ghcr.io/moira-mcp/moira:latest}");
    expect(supervisor).toContain(
      "command=/app/scripts/self-host-startup-guard.sh /app/scripts/init-database.sh",
    );
    expect(supervisor).toContain("stopasgroup=true");
    expect(supervisor).toContain("killasgroup=true");
    expect(supervisor).toContain("MOIRA_STOP_CONTAINER_ON_INIT_FAILURE=1");
    expect(supervisor).toContain("stdout_logfile=/dev/fd/1");
    expect(supervisor).toContain("stdout_logfile_maxbytes=0");
    expect(compose).toContain('restart: "on-failure:3"');
    expect(entrypoint).toContain(
      'rm -f -- "$sentinel_dir/init-success" "$sentinel_dir/init-failed"',
    );
    expect(entrypoint).toContain('"$sentinel_dir/workflow-reconciliation-required"');
    expect(startupGuard).toContain("sqlite-online-backup.sh");
    expect(startupGuard).toContain(".moira-startup-backups");
    expect(startupGuard).toContain("initialization.pending");
    expect(startupGuard).toContain("initialization.committed");
    expect(startupGuard).toContain("MOIRA_INIT_SENTINEL_OWNER=guard");
    expect(startupGuard).toContain('mktemp -d "$STATE_DIR/.next.XXXXXX"');
    expect(startupGuard).toContain("STARTUP_RESTORE_OK");
    expect(startupGuard.split("\n").some((line) => /^\s*docker(?:\s|$)/.test(line))).toBe(false);
  });

  test("keeps the advanced helper pinned and delegates coherent backup", () => {
    expect(script).toContain("mutable image tags are forbidden");
    expect(script).toContain("/app/scripts/sqlite-online-backup.sh");
    expect(script).toContain(":/source:ro");
    expect(script).toContain("MOIRA_UPGRADE_DIR:-./.moira-upgrade");
    expect(gitignore).toContain(".moira-upgrade/");
    expect(dockerignore).toContain(".moira-upgrade/");
    expect(script).not.toContain('cp "$DATA_DIR/moira.db"');
    expect(() =>
      execFileSync(resolve("scripts/self-host-upgrade.sh"), [
        "preflight",
        "ghcr.io/moira-mcp/moira:latest",
      ]),
    ).toThrow();
  });

  test("preflights an isolated copy and supports guarded replacement and rollback", () => {
    expect(script).toContain('"$(cd "$PREFLIGHT_DIR" && pwd):/app/data"');
    expect(script).toContain("DEPLOYMENT_MODE=self-host");
    expect(script).toContain("PROMPT_CONFLICT_FATAL=0");
    expect(script).toContain("docker compose up -d --no-deps --wait --wait-timeout 120 moira");
    expect(script).toContain('cp "$BACKUP" "$DATA_DIR/moira.db"');
    expect(script.indexOf('sqlite3 "$BACKUP"')).toBeLessThan(
      script.indexOf("docker compose stop moira"),
    );
    expect(script).toContain("health-check.sh");
  });
});
