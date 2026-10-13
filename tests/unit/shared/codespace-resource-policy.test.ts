import { describe, expect, test } from "@jest/globals";
import { effectiveCodespaceLimits, evaluateCodespaceResourcePolicy } from "@mcp-moira/shared";

const policy = (values: Record<string, string> = {}) =>
  evaluateCodespaceResourcePolicy((name) => values[name]);

describe("provider lifecycle policy", () => {
  test("has no cloud execution, file, transfer or relay quotas", () => {
    expect(effectiveCodespaceLimits(policy())).toEqual({
      persistentRetentionMs: 30 * 24 * 60 * 60_000,
      transfers: { ttlMs: 600_000 },
    });
    expect(
      policy({
        CODESPACE_MAX_OPERATION_SECONDS: "1",
        CODESPACE_MAX_TRANSFER_FILE_MB: "1",
        CODESPACE_MAX_BACKGROUND_OPERATION_HOURS: "1",
      }),
    ).toEqual(policy());
  });
  test("keeps explicit provider billing capacity and lifecycle settings", () => {
    expect(policy()).toMatchObject({
      enabled: false,
      maxCpuCores: 4,
      maxMemoryBytes: 8 * 1024 ** 3,
      maxStorageBytes: 32 * 1024 ** 3,
      maxActivePerUser: 4,
      maxActiveGlobal: 16,
      startWaitMs: 180_000,
    });
    expect(
      policy({
        CODESPACE_CODESPACES_ENABLED: "true",
        CODESPACE_MAX_MEMORY_GB: "4",
        CODESPACE_CREATE_THROTTLE_SECONDS: "30",
        CODESPACE_START_WAIT_SECONDS: "45",
        CODESPACE_MAX_ACTIVE_PER_USER: "65",
        CODESPACE_MAX_ACTIVE_GLOBAL: "1025",
        CODESPACE_TRANSFER_TTL_MINUTES: "61",
      }),
    ).toMatchObject({
      enabled: true,
      maxMemoryBytes: 4 * 1024 ** 3,
      createThrottleMs: 30_000,
      startWaitMs: 45_000,
      maxActivePerUser: 65,
      maxActiveGlobal: 1025,
      transferTtlMs: 61 * 60_000,
    });
    expect(policy({ CODESPACE_START_WAIT_SECONDS: "901" }).startWaitMs).toBe(901_000);
  });
  test("refuses malformed provider policy and numeric overflow", () => {
    expect(() => policy({ CODESPACE_CODESPACES_ENABLED: "yes" })).toThrow(/true or false/);
    expect(() => policy({ CODESPACE_MAX_CPU_CORES: "0" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_MAX_MEMORY_GB: String(Number.MAX_SAFE_INTEGER) })).toThrow(
      /safe configured range/,
    );
    expect(() =>
      policy({ CODESPACE_MAX_ACTIVE_PER_USER: "3", CODESPACE_MAX_ACTIVE_GLOBAL: "2" }),
    ).toThrow(/cannot be lower/);
    expect(() => policy({ CODESPACE_PERSISTENT_RETENTION_DAYS: "31" })).toThrow(/between/);
  });
});
