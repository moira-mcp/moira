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
  const commands = [
    "MOIRA_IMAGE=ghcr.io/moira-mcp/moira:0.3.5",
    "MOIRA_VERSION=0.3.5",
    'curl -fLO "$MOIRA_RELEASE/docker-compose.yml"',
    'curl -fLo scripts/self-host-upgrade.sh "$MOIRA_RELEASE/scripts/self-host-upgrade.sh"',
    "chmod +x scripts/self-host-upgrade.sh",
    "docker compose exec -T moira cat /app/BUILD_INFO",
    "df -h ./data && test -r ./data/moira.db && test -w ./data",
    "./scripts/self-host-upgrade.sh backup ghcr.io/moira-mcp/moira:0.3.6",
    "./scripts/self-host-upgrade.sh preflight ghcr.io/moira-mcp/moira:0.3.6",
    "./scripts/self-host-upgrade.sh upgrade ghcr.io/moira-mcp/moira:0.3.6",
    "./scripts/self-host-upgrade.sh rollback",
    "PRAGMA integrity_check;",
  ];

  test.each(commands)("documents executable command in EN and RU: %s", (command) => {
    expect(english).toContain(command);
    expect(russian).toContain(command);
  });

  test("documents reconciliation recovery and immutable pins in both languages", () => {
    for (const document of [english, russian]) {
      expect(document).toContain("Workflow Management Flow");
      expect(document).toContain("reconciliation");
      expect(
        document.slice(
          0,
          document.indexOf("## Safe Upgrade") > 0
            ? document.indexOf("## Safe Upgrade")
            : document.indexOf("## Безопасное обновление"),
        ),
      ).not.toContain(":latest");
      expect(document).toContain(".moira-upgrade/preflight/");
      expect(document).toContain("scripts/self-host-upgrade.sh");
      expect(document).toContain("sqlite3");
    }
    expect(envExample).not.toContain("pulls ghcr.io/moira-mcp/moira:latest");
    expect(envExample).toContain("MOIRA_IMAGE=ghcr.io/moira-mcp/moira:0.3.5");
    expect(compose).toContain("${MOIRA_IMAGE:-ghcr.io/moira-mcp/moira:0.3.5}");
  });
});
