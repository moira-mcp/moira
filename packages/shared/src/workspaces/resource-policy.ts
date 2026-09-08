import type { WorkspaceResourcePolicy } from "./resource-types.js";

export type WorkspacePolicyEnvironment = (name: string) => string | undefined;

export function evaluateWorkspaceResourcePolicy(
  environment: WorkspacePolicyEnvironment,
): WorkspaceResourcePolicy {
  const integer = (
    name: string,
    fallback: number,
    minimum = 1,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number => {
    const raw = environment(name);
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  };
  const scaledInteger = (
    name: string,
    fallback: number,
    scale: number,
    minimum = 1,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number => {
    const value = integer(name, fallback, minimum, maximum) * scale;
    if (!Number.isSafeInteger(value)) throw new Error(`${name} exceeds the safe configured range`);
    return value;
  };
  const enabledValue = environment("WORKSPACE_CODESPACES_ENABLED");
  if (enabledValue !== undefined && !["true", "false"].includes(enabledValue)) {
    throw new Error("WORKSPACE_CODESPACES_ENABLED must be true or false");
  }
  const maxActivePerUser = integer("WORKSPACE_MAX_ACTIVE_PER_USER", 1, 1, 64);
  const maxActiveGlobal = integer("WORKSPACE_MAX_ACTIVE_GLOBAL", 4, 1, 1024);
  const maxConcurrentOperationsPerUser = integer(
    "WORKSPACE_MAX_CONCURRENT_OPERATIONS_PER_USER",
    2,
    1,
    32,
  );
  const maxConcurrentOperationsGlobal = integer(
    "WORKSPACE_MAX_CONCURRENT_OPERATIONS_GLOBAL",
    20,
    1,
    256,
  );
  const persistentRetentionDays = integer("WORKSPACE_PERSISTENT_RETENTION_DAYS", 30);
  if (maxActiveGlobal < maxActivePerUser) {
    throw new Error(
      "WORKSPACE_MAX_ACTIVE_GLOBAL cannot be lower than WORKSPACE_MAX_ACTIVE_PER_USER",
    );
  }
  if (maxConcurrentOperationsGlobal < maxConcurrentOperationsPerUser) {
    throw new Error(
      "WORKSPACE_MAX_CONCURRENT_OPERATIONS_GLOBAL cannot be lower than WORKSPACE_MAX_CONCURRENT_OPERATIONS_PER_USER",
    );
  }
  if (persistentRetentionDays > 30) {
    throw new Error("WORKSPACE_PERSISTENT_RETENTION_DAYS cannot exceed 30");
  }
  return {
    enabled: enabledValue === "true",
    maxCpuCores: integer("WORKSPACE_MAX_CPU_CORES", 4),
    maxMemoryBytes: scaledInteger("WORKSPACE_MAX_MEMORY_GB", 8, 1024 ** 3),
    maxStorageBytes: scaledInteger("WORKSPACE_MAX_STORAGE_GB", 32, 1024 ** 3),
    maxActivePerUser,
    maxActiveGlobal,
    maxOperationsPerDay: integer("WORKSPACE_MAX_OPERATIONS_PER_DAY", 10, 1, 10_000),
    createThrottleMs: scaledInteger("WORKSPACE_CREATE_THROTTLE_SECONDS", 60, 1000),
    remoteTtlMs: scaledInteger("WORKSPACE_REMOTE_TTL_MINUTES", 120, 60_000, 5),
    persistentRetentionMs: persistentRetentionDays * 24 * 60 * 60_000,
    createDeadlineMs: scaledInteger("WORKSPACE_CREATE_DEADLINE_MINUTES", 15, 60_000),
    cleanupDeadlineMs: scaledInteger("WORKSPACE_CLEANUP_DEADLINE_MINUTES", 15, 60_000),
    claimLeaseMs: scaledInteger("WORKSPACE_CLAIM_LEASE_SECONDS", 30, 1000),
    reconcileIntervalMs: scaledInteger("WORKSPACE_RECONCILE_INTERVAL_SECONDS", 30, 1000),
    maxConcurrentOperationsPerUser,
    maxConcurrentOperationsGlobal,
    maxOperationInputBytes: scaledInteger("WORKSPACE_MAX_OPERATION_INPUT_KB", 1024, 1024, 1, 4096),
    maxOperationStdoutBytes: scaledInteger(
      "WORKSPACE_MAX_OPERATION_STDOUT_KB",
      1024,
      1024,
      1,
      8192,
    ),
    maxOperationStderrBytes: scaledInteger("WORKSPACE_MAX_OPERATION_STDERR_KB", 256, 1024, 1, 8192),
    maxOperationMs: scaledInteger("WORKSPACE_MAX_OPERATION_SECONDS", 900, 1000, 1, 900),
  };
}
