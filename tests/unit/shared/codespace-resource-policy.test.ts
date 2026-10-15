import { describe, expect, test } from "@jest/globals";
import { evaluateCodespaceResourcePolicy } from "@mcp-moira/shared";

const policy = (values: Record<string, string> = {}) =>
  evaluateCodespaceResourcePolicy((name) => values[name]);

describe("provider lifecycle policy", () => {
  test("has no cloud execution, file, transfer or relay quotas", () => {
    expect(policy()).toEqual({
      enabled: false,
      persistentRetentionMs: 30 * 24 * 60 * 60_000,
    });
    expect(
      policy({
        CODESPACE_MAX_OPERATION_SECONDS: "1",
        CODESPACE_MAX_TRANSFER_FILE_MB: "1",
        CODESPACE_MAX_BACKGROUND_OPERATION_HOURS: "1",
      }),
    ).toEqual(policy());
  });
  test("keeps provider retention while retired cloud settings have no effect", () => {
    expect(policy()).toMatchObject({
      enabled: false,
      persistentRetentionMs: 30 * 24 * 60 * 60_000,
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
    });
    expect(
      policy({
        CODESPACE_MAX_MEMORY_GB: "4",
        CODESPACE_CREATE_THROTTLE_SECONDS: "30",
        CODESPACE_START_WAIT_SECONDS: "901",
        CODESPACE_MAX_ACTIVE_PER_USER: "65",
        CODESPACE_MAX_ACTIVE_GLOBAL: "1025",
      }),
    ).toEqual(policy());
  });
  test("refuses malformed provider policy and numeric overflow", () => {
    expect(() => policy({ CODESPACE_CODESPACES_ENABLED: "yes" })).toThrow(/true or false/);
    expect(policy({ CODESPACE_TRANSFER_TTL_MINUTES: String(Number.MAX_SAFE_INTEGER) })).toEqual(
      policy(),
    );
    expect(() => policy({ CODESPACE_PERSISTENT_RETENTION_DAYS: "0" })).toThrow(/between/);
    expect(() => policy({ CODESPACE_PERSISTENT_RETENTION_DAYS: "31" })).toThrow(/between/);
  });
});
