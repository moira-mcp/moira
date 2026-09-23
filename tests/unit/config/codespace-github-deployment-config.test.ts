import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "@jest/globals";
import { evaluateCodespaceResourcePolicy } from "@mcp-moira/shared";

const secretNames = ["CODESPACE_GITHUB_APP_CLIENT_SECRET", "CODESPACE_CREDENTIAL_VAULT_KEY"];
const allNames = [
  "CODESPACE_GITHUB_APP_CLIENT_ID",
  ...secretNames,
  "CODESPACE_GITHUB_APP_CALLBACK_URL",
  "CODESPACE_GITHUB_APP_INSTALL_URL",
  "CODESPACE_CREDENTIAL_VAULT_KEY_VERSION",
  "CODESPACE_CODESPACES_ENABLED",
  "CODESPACE_MAX_CPU_CORES",
  "CODESPACE_MAX_MEMORY_GB",
  "CODESPACE_MAX_STORAGE_GB",
  "CODESPACE_MAX_ACTIVE_PER_USER",
  "CODESPACE_MAX_ACTIVE_GLOBAL",
  "CODESPACE_CREATE_THROTTLE_SECONDS",
  "CODESPACE_PERSISTENT_RETENTION_DAYS",
  "CODESPACE_CREATE_DEADLINE_MINUTES",
  "CODESPACE_CLEANUP_DEADLINE_MINUTES",
  "CODESPACE_CLAIM_LEASE_SECONDS",
  "CODESPACE_RECONCILE_INTERVAL_SECONDS",
  "CODESPACE_START_WAIT_SECONDS",
  "CODESPACE_MAX_CONCURRENT_OPERATIONS_PER_USER",
  "CODESPACE_MAX_CONCURRENT_OPERATIONS_GLOBAL",
  "CODESPACE_MAX_OPERATION_INPUT_KB",
  "CODESPACE_MAX_OPERATION_STDOUT_KB",
  "CODESPACE_MAX_OPERATION_STDERR_KB",
  "CODESPACE_MAX_RETAINED_OUTPUT_MB",
  "CODESPACE_MAX_OPERATION_SECONDS",
  "CODESPACE_MAX_BACKGROUND_OPERATION_HOURS",
  "CODESPACE_MAX_TRANSFER_FILE_MB",
  "CODESPACE_MAX_TRANSFER_TOTAL_MB_PER_USER",
  "CODESPACE_MAX_TRANSFER_TOTAL_MB_GLOBAL",
  "CODESPACE_MAX_TRANSFER_OBJECTS_PER_USER",
  "CODESPACE_MAX_TRANSFER_OBJECTS_GLOBAL",
  "CODESPACE_MAX_TRANSFER_INFLIGHT_MB_PER_USER",
  "CODESPACE_MAX_TRANSFER_INFLIGHT_MB_GLOBAL",
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

  test("ships the same codespace policy whether or not the operator supplies a value", () => {
    // Compose declares every codespace variable explicitly, so an absent key reaches the container
    // as the file's own fallback and the code default is never consulted. A fallback that drifts
    // from the code default silently ships a different policy than the one documented.
    const source = readFileSync(resolve(process.cwd(), "docker-compose.yml"), "utf8");
    const fallbacks = new Map<string, string>();
    for (const name of allNames) {
      const declaration = new RegExp(`- ${name}=\\$\\{${name}(:-([^}]*))?\\}`).exec(source);
      expect(declaration).not.toBeNull();
      fallbacks.set(name, declaration?.[2] ?? "");
    }
    expect(evaluateCodespaceResourcePolicy((name) => fallbacks.get(name))).toEqual(
      evaluateCodespaceResourcePolicy(() => undefined),
    );
  });

  test("pins the reviewed GitHub CLI and OpenSSH runtime dependencies", () => {
    const source = readFileSync(resolve(process.cwd(), "config/Dockerfile"), "utf8");
    expect(source).toContain("github-cli=2.97.0-r1");
    expect(source).toContain("openssh-client-default=10.3_p1-r1");
    expect(source).toContain("util-linux-misc=2.42.3-r1");
  });

  test("isolates credential work behind a Unix socket and a credential-free egress proxy", () => {
    const source = readFileSync(resolve(process.cwd(), "docker-compose.yml"), "utf8");
    expect(source).toContain("codespace_connector_run:/run/moira-codespace-connector");
    expect(source).toContain("codespace_egress_run:/run/moira-codespace-egress");
    expect(source).toContain("network_mode: none");
    expect(source).toContain("HTTPS_PROXY=http://127.0.0.1:18080");
    const connector = source
      .split("\n  moira-codespace-connector:\n")[1]
      .split("\n  moira-codespace-egress:\n")[0];
    expect(connector).toContain('profiles: ["codespaces"]');
    expect(connector).not.toContain("./data:/app/data");
    expect(source).not.toMatch(/docker\.sock/);
  });
});
