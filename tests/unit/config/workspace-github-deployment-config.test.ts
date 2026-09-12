import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";

const secretNames = ["WORKSPACE_GITHUB_APP_CLIENT_SECRET", "WORKSPACE_CREDENTIAL_VAULT_KEY"];
const allNames = [
  "WORKSPACE_GITHUB_APP_CLIENT_ID",
  ...secretNames,
  "WORKSPACE_GITHUB_APP_CALLBACK_URL",
  "WORKSPACE_GITHUB_APP_INSTALL_URL",
  "WORKSPACE_CREDENTIAL_VAULT_KEY_VERSION",
  "WORKSPACE_CODESPACES_ENABLED",
  "WORKSPACE_MAX_CPU_CORES",
  "WORKSPACE_MAX_MEMORY_GB",
  "WORKSPACE_MAX_STORAGE_GB",
  "WORKSPACE_MAX_ACTIVE_PER_USER",
  "WORKSPACE_MAX_ACTIVE_GLOBAL",
  "WORKSPACE_MAX_OPERATIONS_PER_DAY",
  "WORKSPACE_CREATE_THROTTLE_SECONDS",
  "WORKSPACE_REMOTE_TTL_MINUTES",
  "WORKSPACE_PERSISTENT_RETENTION_DAYS",
  "WORKSPACE_CREATE_DEADLINE_MINUTES",
  "WORKSPACE_CLEANUP_DEADLINE_MINUTES",
  "WORKSPACE_CLAIM_LEASE_SECONDS",
  "WORKSPACE_RECONCILE_INTERVAL_SECONDS",
  "WORKSPACE_MAX_CONCURRENT_OPERATIONS_PER_USER",
  "WORKSPACE_MAX_CONCURRENT_OPERATIONS_GLOBAL",
  "WORKSPACE_MAX_OPERATION_INPUT_KB",
  "WORKSPACE_MAX_OPERATION_STDOUT_KB",
  "WORKSPACE_MAX_OPERATION_STDERR_KB",
  "WORKSPACE_MAX_OPERATION_SECONDS",
  "WORKSPACE_MAX_TRANSFER_FILE_MB",
  "WORKSPACE_MAX_TRANSFER_TOTAL_MB_PER_USER",
  "WORKSPACE_MAX_TRANSFER_TOTAL_MB_GLOBAL",
  "WORKSPACE_MAX_TRANSFER_OBJECTS_PER_USER",
  "WORKSPACE_MAX_TRANSFER_OBJECTS_GLOBAL",
  "WORKSPACE_MAX_TRANSFER_INFLIGHT_MB_PER_USER",
  "WORKSPACE_MAX_TRANSFER_INFLIGHT_MB_GLOBAL",
  "WORKSPACE_TRANSFER_TTL_MINUTES",
];

describe("GitHub workspace deployment configuration", () => {
  test("documents every workspace-specific name without committing a secret value", () => {
    for (const filename of [".env.example", ".env.local.example"]) {
      const source = readFileSync(resolve(process.cwd(), filename), "utf8");
      for (const name of allNames) expect(source).toContain(`${name}=`);
      for (const name of secretNames) {
        expect(source).toMatch(new RegExp(`^${name}=$`, "m"));
      }
    }
  });

  test("passes workspace values only through operator-owned Compose references", () => {
    const source = readFileSync(resolve(process.cwd(), "docker-compose.yml"), "utf8");
    for (const name of allNames) {
      expect(source).toContain(`${name}=\${${name}`);
    }
    expect(source).not.toMatch(/WORKSPACE_GITHUB_APP_CLIENT_SECRET=[A-Za-z0-9_-]{8,}/);
    expect(source).not.toMatch(/WORKSPACE_CREDENTIAL_VAULT_KEY=[0-9a-f]{64}/i);
  });

  test("pins the reviewed GitHub CLI and OpenSSH runtime dependencies", () => {
    const source = readFileSync(resolve(process.cwd(), "config/Dockerfile"), "utf8");
    expect(source).toContain("github-cli=2.97.0-r1");
    expect(source).toContain("openssh-client-default=10.3_p1-r1");
    expect(source).toContain("util-linux-misc=2.42.3-r1");
  });

  test("isolates credential work behind a Unix socket and a credential-free egress proxy", () => {
    const source = readFileSync(resolve(process.cwd(), "docker-compose.yml"), "utf8");
    expect(source).toContain("workspace_connector_run:/run/moira-workspace-connector");
    expect(source).toContain("workspace_egress_run:/run/moira-workspace-egress");
    expect(source).toContain("network_mode: none");
    expect(source).toContain("HTTPS_PROXY=http://127.0.0.1:18080");
    const connector = source
      .split("\n  moira-workspace-connector:\n")[1]
      .split("\n  moira-workspace-egress:\n")[0];
    expect(connector).toContain('profiles: ["workspaces"]');
    expect(connector).not.toContain("./data:/app/data");
    expect(source).not.toMatch(/docker\.sock/);
  });
});
