import { describe, expect, test } from "@jest/globals";
import { evaluateWorkspaceResourcePolicy } from "@mcp-moira/shared";

function policy(values: Record<string, string> = {}) {
  return evaluateWorkspaceResourcePolicy((name) => values[name]);
}

describe("workspace resource policy", () => {
  test("is disabled by default with finite hard ceilings", () => {
    expect(policy()).toMatchObject({
      enabled: false,
      maxCpuCores: 4,
      maxMemoryBytes: 8 * 1024 ** 3,
      maxStorageBytes: 32 * 1024 ** 3,
      maxActivePerUser: 1,
      maxActiveGlobal: 4,
      maxOperationsPerDay: 10,
    });
  });

  test("converts configured units and rejects malformed or internally inconsistent limits", () => {
    expect(
      policy({
        WORKSPACE_CODESPACES_ENABLED: "true",
        WORKSPACE_MAX_MEMORY_GB: "4",
        WORKSPACE_REMOTE_TTL_MINUTES: "30",
      }),
    ).toMatchObject({ enabled: true, maxMemoryBytes: 4 * 1024 ** 3, remoteTtlMs: 1_800_000 });
    expect(() => policy({ WORKSPACE_CODESPACES_ENABLED: "yes" })).toThrow(/true or false/);
    expect(() => policy({ WORKSPACE_MAX_CPU_CORES: "0" })).toThrow(/greater than or equal/);
    expect(() => policy({ WORKSPACE_MAX_MEMORY_GB: String(Number.MAX_SAFE_INTEGER) })).toThrow(
      /safe configured range/,
    );
    expect(() =>
      policy({ WORKSPACE_MAX_ACTIVE_PER_USER: "3", WORKSPACE_MAX_ACTIVE_GLOBAL: "2" }),
    ).toThrow(/cannot be lower/);
  });
});
