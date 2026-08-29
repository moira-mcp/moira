import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

describe("self-host upgrade documentation parity", () => {
  const english = readFileSync(
    resolve("packages/docs/src/content/docs/docs/getting-started/self-hosting.mdx"),
    "utf8",
  );
  const russian = readFileSync(
    resolve("packages/docs/src/content/docs/ru/docs/getting-started/self-hosting.mdx"),
    "utf8",
  );
  const envExample = readFileSync(resolve(".env.example"), "utf8");
  const compose = readFileSync(resolve("docker-compose.yml"), "utf8");
  const readme = readFileSync(resolve("README.md"), "utf8");
  const internalWorkflows = readFileSync(resolve("docs/WORKFLOWS.md"), "utf8");
  const commands = [
    "docker compose pull",
    "docker compose up -d",
    "docker compose ps",
    "docker compose logs moira",
    "docker compose restart moira",
    "/app/data/.moira-startup-backups/current/moira.db",
    "RELEASE_VERSION=x.y.z",
    './self-host-upgrade.sh preflight "$TARGET_IMAGE"',
    './self-host-upgrade.sh upgrade "$TARGET_IMAGE"',
    "./self-host-upgrade.sh rollback",
    "PRAGMA integrity_check;",
  ];

  test.each(commands)("documents executable command in EN and RU: %s", (command) => {
    expect(english).toContain(command);
    expect(russian).toContain(command);
  });

  test("documents automatic recovery and optional advanced preflight in both languages", () => {
    for (const document of [english, russian]) {
      expect(document).toContain("docker compose run --rm moira npm run reconcile -- status");
      expect(document).toContain("previous.json");
      expect(document).toContain("incoming.json");
      expect(document).toContain("reconciliation");
      expect(document).toContain("data/.moira-startup-backups/current/");
      expect(document).toContain("previous-1/");
      expect(document).toContain("previous-2/");
      expect(document).toContain("/tmp/init-failed");
      expect(document).toContain("ghcr.io/moira-mcp/moira:latest");
      expect(document).toContain("self-host-upgrade.sh");
    }
    expect(envExample).toContain("MOIRA_IMAGE=ghcr.io/moira-mcp/moira:latest");
    expect(compose).toContain("${MOIRA_IMAGE:-ghcr.io/moira-mcp/moira:latest}");
    expect(readme).toContain("data/.moira-startup-backups/");
    expect(english).toContain("persistent initialization-pending marker");
    expect(english).toContain("without a fake database backup");
    expect(russian).toContain("persistent-маркер незавершённой инициализации");
    expect(russian).toContain("без фиктивной backup-БД");
    for (const source of [english, russian, envExample, compose, readme]) {
      expect(source).not.toContain("ghcr.io/moira-mcp/moira:0.3.5");
      expect(source).not.toContain("ghcr.io/moira-mcp/moira:0.3.6");
    }
  });

  test("keeps internal self-host recovery on the revision-bound local Compose CLI", () => {
    expect(internalWorkflows).toContain(
      "docker compose run --rm moira npm run reconcile -- status",
    );
    expect(internalWorkflows).toContain("--selection current --revision REVISION");
    expect(internalWorkflows).toContain('--rationale "Retain the reviewed local intent"');
    expect(internalWorkflows).toContain("docker compose run --rm moira npm run reconcile -- apply");
    expect(internalWorkflows).not.toContain(
      "npx tsx scripts/migrate-workflows-in-docker.ts --resolve owner/slug:current",
    );
    expect(internalWorkflows).not.toContain("semantic WMF merge against the refreshed candidates");
  });
});
