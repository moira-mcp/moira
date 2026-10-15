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
  return {
    enabled: enabled === "true",
    persistentRetentionMs: scaled(
      "CODESPACE_PERSISTENT_RETENTION_DAYS",
      30,
      24 * 60 * 60_000,
      1,
      30,
    ),
  };
}
