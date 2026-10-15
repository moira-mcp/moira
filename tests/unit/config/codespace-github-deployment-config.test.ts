import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

const secretNames = ["CODESPACE_GITHUB_APP_CLIENT_SECRET", "CODESPACE_CREDENTIAL_VAULT_KEY"];
const allNames = [
  "CODESPACE_GITHUB_APP_CLIENT_ID",
  ...secretNames,
  "CODESPACE_GITHUB_APP_CALLBACK_URL",
  "CODESPACE_GITHUB_APP_INSTALL_URL",
  "CODESPACE_CREDENTIAL_VAULT_KEY_VERSION",
  "CODESPACE_CODESPACES_ENABLED",
  "CODESPACE_PERSISTENT_RETENTION_DAYS",
  "CODESPACE_TRANSFER_TTL_MINUTES",
];

describe("GitHub codespace deployment configuration", () => {
  test("documents every codespace-specific name without committing a secret value", () => {
    for (const filename of [".env.example", ".env.local.example"]) {
      const source = readFileSync(resolve(process.cwd(), filename), "utf8");
      for (const name of allNames) expect(source).toContain(`${name}=`);
      for (const name of secretNames) {
        expect(source).toMatch(new RegExp(`^${name}=$`, "m"));
      }
    }
  });

  test("offers no setting that controls nothing: the removed remote expiry is not configurable", () => {
    // Persistent codespaces never expire, and legacy disposable rows expire by the time stamped
    // when they were created, so an operator value would change no behaviour at all.
    for (const filename of [".env.example", ".env.local.example", "docker-compose.yml"]) {
      const source = readFileSync(resolve(process.cwd(), filename), "utf8");
      expect(source).not.toContain("CODESPACE_REMOTE_TTL_MINUTES");
    }
  });

  test("passes codespace values only through operator-owned Compose references", () => {
    const source = readFileSync(resolve(process.cwd(), "docker-compose.yml"), "utf8");
    for (const name of allNames) {
      expect(source).toContain(`${name}=\${${name}`);
    }
    expect(source).not.toMatch(/CODESPACE_GITHUB_APP_CLIENT_SECRET=[A-Za-z0-9_-]{8,}/);
    expect(source).not.toMatch(/CODESPACE_CREDENTIAL_VAULT_KEY=[0-9a-f]{64}/i);
  });
});
