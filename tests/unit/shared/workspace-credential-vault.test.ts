import { describe, expect, test } from "@jest/globals";
import { WorkspaceCredentialVault } from "@mcp-moira/shared";

const key = "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805";
const payload = {
  accessToken: "ghu_access-secret-fixture",
  refreshToken: "ghr_refresh-secret-fixture",
  accessTokenExpiresAt: 2_000_000,
  refreshTokenExpiresAt: 3_000_000,
};

describe("WorkspaceCredentialVault", () => {
  test("round-trips one versioned credential without placing plaintext in its envelope", () => {
    const vault = new WorkspaceCredentialVault(key, "v1");
    const envelope = vault.encrypt("user-a", "github-codespaces", "connection-a", 3, payload);

    expect(envelope).toMatchObject({ envelopeVersion: 1, keyVersion: "v1", generation: 3 });
    expect(JSON.stringify(envelope)).not.toContain(payload.accessToken);
    expect(JSON.stringify(envelope)).not.toContain(payload.refreshToken);
    expect(vault.decrypt("user-a", "github-codespaces", "connection-a", envelope)).toEqual(payload);
  });

  test("rejects ciphertext copied to another tenant, provider, or connection", () => {
    const vault = new WorkspaceCredentialVault(key, "v1");
    const envelope = vault.encrypt("user-a", "github-codespaces", "connection-a", 1, payload);

    expect(() => vault.decrypt("user-b", "github-codespaces", "connection-a", envelope)).toThrow(
      "decryption failed",
    );
    expect(() => vault.decrypt("user-a", "other-provider", "connection-a", envelope)).toThrow(
      "decryption failed",
    );
    expect(() => vault.decrypt("user-a", "github-codespaces", "connection-b", envelope)).toThrow(
      "decryption failed",
    );
  });

  test("uses a distinct nonce for the same credential and rejects key-version drift", () => {
    const vault = new WorkspaceCredentialVault(key, "v1");
    const first = vault.encrypt("user-a", "github-codespaces", "connection-a", 1, payload);
    const second = vault.encrypt("user-a", "github-codespaces", "connection-a", 1, payload);
    expect(second.iv).not.toBe(first.iv);
    expect(() =>
      new WorkspaceCredentialVault(key, "v2").decrypt(
        "user-a",
        "github-codespaces",
        "connection-a",
        first,
      ),
    ).toThrow("Unsupported workspace credential envelope");
  });
});
