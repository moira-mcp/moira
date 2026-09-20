import { describe, expect, test } from "@jest/globals";
import crypto from "node:crypto";
import { CodespaceCredentialVault } from "@mcp-moira/shared";
import type { CodespaceCredentialEnvelope } from "@mcp-moira/shared";

const key = "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805";
const payload = {
  accessToken: "ghu_access-secret-fixture",
  refreshToken: "ghr_refresh-secret-fixture",
  accessTokenExpiresAt: 2_000_000,
  refreshTokenExpiresAt: 3_000_000,
};

function legacyEnvelope(): CodespaceCredentialEnvelope {
  const iv = Buffer.alloc(12, 7);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify(["moira-workspace-credential", "user-a", "github-codespaces", "connection-a"]),
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    envelopeVersion: 1,
    keyVersion: "v1",
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    generation: 1,
  };
}

describe("CodespaceCredentialVault", () => {
  test("round-trips one versioned credential without placing plaintext in its envelope", () => {
    const vault = new CodespaceCredentialVault(key, "v1");
    const envelope = vault.encrypt("user-a", "github-codespaces", "connection-a", 3, payload);

    expect(envelope).toMatchObject({ envelopeVersion: 2, keyVersion: "v1", generation: 3 });
    expect(JSON.stringify(envelope)).not.toContain(payload.accessToken);
    expect(JSON.stringify(envelope)).not.toContain(payload.refreshToken);
    expect(vault.decrypt("user-a", "github-codespaces", "connection-a", envelope)).toEqual(payload);
  });

  test("decrypts the persisted version-1 authenticated context after the codespace rename", () => {
    const vault = new CodespaceCredentialVault(key, "v1");
    expect(vault.decrypt("user-a", "github-codespaces", "connection-a", legacyEnvelope())).toEqual(
      payload,
    );
  });

  test("rejects ciphertext copied to another tenant, provider, or connection", () => {
    const vault = new CodespaceCredentialVault(key, "v1");
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
    const vault = new CodespaceCredentialVault(key, "v1");
    const first = vault.encrypt("user-a", "github-codespaces", "connection-a", 1, payload);
    const second = vault.encrypt("user-a", "github-codespaces", "connection-a", 1, payload);
    expect(second.iv).not.toBe(first.iv);
    expect(() =>
      new CodespaceCredentialVault(key, "v2").decrypt(
        "user-a",
        "github-codespaces",
        "connection-a",
        first,
      ),
    ).toThrow("Unsupported codespace credential envelope");
  });
});
