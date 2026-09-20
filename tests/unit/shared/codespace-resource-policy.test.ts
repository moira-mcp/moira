import { describe, expect, test } from "@jest/globals";
import { evaluateCodespaceResourcePolicy } from "@mcp-moira/shared";

function policy(values: Record<string, string> = {}) {
  return evaluateCodespaceResourcePolicy((name) => values[name]);
}

describe("codespace resource policy", () => {
  test("has no per-day operation budget and ignores the removed variable", () => {
    expect(policy()).not.toHaveProperty("maxOperationsPerDay");
    expect(policy({ CODESPACE_MAX_OPERATIONS_PER_DAY: "1" })).toEqual(policy());
  });

  test("is disabled by default with finite hard ceilings", () => {
    expect(policy()).toMatchObject({
      enabled: false,
      maxCpuCores: 4,
      maxMemoryBytes: 8 * 1024 ** 3,
      maxStorageBytes: 32 * 1024 ** 3,
      maxActivePerUser: 4,
      maxActiveGlobal: 16,
      persistentRetentionMs: 30 * 24 * 60 * 60_000,
      maxConcurrentOperationsPerUser: 8,
      maxConcurrentOperationsGlobal: 32,
      maxOperationInputBytes: 1024 * 1024,
      maxOperationStdoutBytes: 1024 * 1024,
      maxOperationStderrBytes: 256 * 1024,
      maxRetainedOutputBytes: 64 * 1024 * 1024,
      maxOperationMs: 900_000,
      maxBackgroundOperationMs: 4 * 60 * 60_000,
      startWaitMs: 180_000,
      maxTransferFileBytes: 4 * 1024 ** 2,
      maxTransferBytesPerUser: 100 * 1024 ** 2,
      maxTransferBytesGlobal: 1024 * 1024 ** 2,
      maxTransferObjectsPerUser: 10,
      maxTransferObjectsGlobal: 1000,
      maxTransferInflightBytesPerUser: 40 * 1024 ** 2,
      maxTransferInflightBytesGlobal: 256 * 1024 ** 2,
      transferTtlMs: 600_000,
    });
  });

  test("converts configured units and rejects malformed or internally inconsistent limits", () => {
    expect(
      policy({
        CODESPACE_CODESPACES_ENABLED: "true",
        CODESPACE_MAX_MEMORY_GB: "4",
        CODESPACE_REMOTE_TTL_MINUTES: "30",
      }),
    ).toMatchObject({ enabled: true, maxMemoryBytes: 4 * 1024 ** 3, remoteTtlMs: 1_800_000 });
    // The wait for a codespace to start is seconds in configuration and milliseconds in policy, and
    // it is bounded on both sides so no deployment can make a caller wait without end or not at all.
    expect(policy({ CODESPACE_START_WAIT_SECONDS: "45" })).toMatchObject({ startWaitMs: 45_000 });
    expect(() => policy({ CODESPACE_START_WAIT_SECONDS: "4" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_START_WAIT_SECONDS: "901" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_CODESPACES_ENABLED: "yes" })).toThrow(/true or false/);
    expect(() => policy({ CODESPACE_MAX_CPU_CORES: "0" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_MAX_MEMORY_GB: String(Number.MAX_SAFE_INTEGER) })).toThrow(
      /safe configured range/,
    );
    expect(() =>
      policy({ CODESPACE_MAX_ACTIVE_PER_USER: "3", CODESPACE_MAX_ACTIVE_GLOBAL: "2" }),
    ).toThrow(/cannot be lower/);
    // One user must not be able to take the whole instance by default.
    expect(policy().maxActiveGlobal).toBeGreaterThan(policy().maxActivePerUser);
    expect(() =>
      policy({
        CODESPACE_MAX_CONCURRENT_OPERATIONS_PER_USER: "3",
        CODESPACE_MAX_CONCURRENT_OPERATIONS_GLOBAL: "2",
      }),
    ).toThrow(/cannot be lower/);
    expect(() => policy({ CODESPACE_PERSISTENT_RETENTION_DAYS: "31" })).toThrow(/cannot exceed/);
    expect(() => policy({ CODESPACE_MAX_OPERATION_INPUT_KB: "4097" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_MAX_OPERATION_STDOUT_KB: "8193" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_MAX_OPERATION_SECONDS: "901" })).toThrow(/between/);
    // A background ceiling is expressed in hours and its smallest accepted value already exceeds
    // the largest bounded-command ceiling, so the two cannot be configured into conflict.
    expect(policy({ CODESPACE_MAX_BACKGROUND_OPERATION_HOURS: "1" }).maxBackgroundOperationMs).toBe(
      3_600_000,
    );
    expect(() => policy({ CODESPACE_MAX_BACKGROUND_OPERATION_HOURS: "0" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_MAX_BACKGROUND_OPERATION_HOURS: "25" })).toThrow(/between/);
    // A command's retained output is disk, not an answer: it must leave room for the payload the
    // answer carries, and it is far larger than that payload by default.
    expect(policy().maxRetainedOutputBytes).toBeGreaterThan(policy().maxOperationStdoutBytes!);
    expect(() =>
      policy({ CODESPACE_MAX_RETAINED_OUTPUT_MB: "1", CODESPACE_MAX_OPERATION_STDOUT_KB: "2048" }),
    ).toThrow(/cannot be lower than a configured response payload bound/);
    expect(() => policy({ CODESPACE_MAX_TRANSFER_FILE_MB: "5" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_MAX_TRANSFER_OBJECTS_PER_USER: "101" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_TRANSFER_TTL_MINUTES: "61" })).toThrow(/between/);
    expect(() =>
      policy({
        CODESPACE_MAX_TRANSFER_FILE_MB: "4",
        CODESPACE_MAX_TRANSFER_TOTAL_MB_PER_USER: "2",
      }),
    ).toThrow(/aggregate limits/);
  });
});
