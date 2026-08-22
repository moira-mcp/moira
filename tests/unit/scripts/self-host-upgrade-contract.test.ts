import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

describe("self-host upgrade contract", () => {
  const script = readFileSync(resolve("scripts/self-host-upgrade.sh"), "utf8");
  const compose = readFileSync(resolve("docker-compose.yml"), "utf8");
  const gitignore = readFileSync(resolve(".gitignore"), "utf8");
  const dockerignore = readFileSync(resolve(".dockerignore"), "utf8");

  test("requires immutable pins and delegates coherent backup", () => {
    expect(compose).toContain("${MOIRA_IMAGE:-ghcr.io/moira-mcp/moira:0.3.5}");
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
