import type { CodespaceResourcePolicy } from "./resource-types.js";

export type CodespacePolicyEnvironment = (name: string) => string | undefined;

/** Provider lifecycle and billing policy; workspace execution has no cloud quota. */
export function evaluateCodespaceResourcePolicy(
  environment: CodespacePolicyEnvironment,
): CodespaceResourcePolicy {
  const integer = (
    name: string,
    fallback: number,
    minimum = 1,
    maximum = Number.MAX_SAFE_INTEGER,
  ): number => {
    const raw = environment(name);
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    return value;
  };
  const scaled = (
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
  const enabled = environment("CODESPACE_CODESPACES_ENABLED");
  if (enabled !== undefined && !["true", "false"].includes(enabled))
    throw new Error("CODESPACE_CODESPACES_ENABLED must be true or false");
  const maxActivePerUser = integer("CODESPACE_MAX_ACTIVE_PER_USER", 4);
  const maxActiveGlobal = integer("CODESPACE_MAX_ACTIVE_GLOBAL", 16);
  if (maxActiveGlobal < maxActivePerUser)
    throw new Error(
      "CODESPACE_MAX_ACTIVE_GLOBAL cannot be lower than CODESPACE_MAX_ACTIVE_PER_USER",
    );
  return {
    enabled: enabled === "true",
    maxCpuCores: integer("CODESPACE_MAX_CPU_CORES", 4),
    maxMemoryBytes: scaled("CODESPACE_MAX_MEMORY_GB", 8, 1024 ** 3),
    maxStorageBytes: scaled("CODESPACE_MAX_STORAGE_GB", 32, 1024 ** 3),
    maxActivePerUser,
    maxActiveGlobal,
    createThrottleMs: scaled("CODESPACE_CREATE_THROTTLE_SECONDS", 60, 1000),
    persistentRetentionMs: scaled(
      "CODESPACE_PERSISTENT_RETENTION_DAYS",
      30,
      24 * 60 * 60_000,
      1,
      30,
    ),
    createDeadlineMs: scaled("CODESPACE_CREATE_DEADLINE_MINUTES", 15, 60_000),
    cleanupDeadlineMs: scaled("CODESPACE_CLEANUP_DEADLINE_MINUTES", 15, 60_000),
    claimLeaseMs: scaled("CODESPACE_CLAIM_LEASE_SECONDS", 30, 1000),
    reconcileIntervalMs: scaled("CODESPACE_RECONCILE_INTERVAL_SECONDS", 30, 1000),
    startWaitMs: scaled("CODESPACE_START_WAIT_SECONDS", 180, 1000),
    transferTtlMs: scaled("CODESPACE_TRANSFER_TTL_MINUTES", 10, 60_000),
  };
}

/** Retention for provider environments and separately published attachment links. */
export function effectiveCodespaceLimits(policy: CodespaceResourcePolicy) {
  return {
    persistentRetentionMs: policy.persistentRetentionMs ?? 30 * 24 * 60 * 60_000,
    transfers: { ttlMs: policy.transferTtlMs ?? 10 * 60_000 },
  };
}
