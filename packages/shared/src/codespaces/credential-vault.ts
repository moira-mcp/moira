import crypto from "node:crypto";
import type { CodespaceCredentialEnvelope, CodespaceCredentialPayload } from "./types.js";
import type { ScopedCredentialPayload } from "./scoped-credential-types.js";

const ALGORITHM = "aes-256-gcm";
const CURRENT_ENVELOPE_VERSION = 2 as const;

function authenticatedContext(
  envelopeVersion: CodespaceCredentialEnvelope["envelopeVersion"],
  userId: string,
  provider: string,
  connectionId: string,
): Buffer {
  // Version 1 is a persisted cryptographic format. Its label cannot be renamed without making
  // credentials written before the codespace migration undecryptable.
  const formatLabel =
    envelopeVersion === 1 ? "moira-workspace-credential" : "moira-codespace-credential";
  return Buffer.from(JSON.stringify([formatLabel, userId, provider, connectionId]));
}

export class CodespaceCredentialVault {
  private readonly key: Buffer;

  constructor(
    keyHex: string,
    private readonly keyVersion: string,
  ) {
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
      throw new Error("Codespace credential vault key must be 64 hexadecimal characters");
    }
    this.key = Buffer.from(keyHex, "hex");
  }

  encrypt(
    userId: string,
    provider: string,
    connectionId: string,
    generation: number,
    payload: CodespaceCredentialPayload,
  ): CodespaceCredentialEnvelope {
    return this.encryptPayload(userId, provider, connectionId, generation, payload);
  }

  private encryptPayload(
    userId: string,
    provider: string,
    connectionId: string,
    generation: number,
    payload: CodespaceCredentialPayload | ScopedCredentialPayload,
  ): CodespaceCredentialEnvelope {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(authenticatedContext(CURRENT_ENVELOPE_VERSION, userId, provider, connectionId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);

    return {
      envelopeVersion: CURRENT_ENVELOPE_VERSION,
      keyVersion: this.keyVersion,
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      generation,
    };
  }

  decrypt(
    userId: string,
    provider: string,
    connectionId: string,
    envelope: CodespaceCredentialEnvelope,
  ): CodespaceCredentialPayload {
    const payload = this.decryptPayload(
      userId,
      provider,
      connectionId,
      envelope,
    ) as Partial<CodespaceCredentialPayload>;
    if (
      typeof payload.accessToken !== "string" ||
      typeof payload.refreshToken !== "string" ||
      !Number.isSafeInteger(payload.accessTokenExpiresAt) ||
      !Number.isSafeInteger(payload.refreshTokenExpiresAt)
    )
      throw new Error("Codespace credential decryption failed");
    return payload as CodespaceCredentialPayload;
  }

  encryptScoped(
    userId: string,
    provider: string,
    credentialId: string,
    generation: number,
    payload: ScopedCredentialPayload,
  ): CodespaceCredentialEnvelope {
    return this.encryptPayload(userId, provider, `scoped:${credentialId}`, generation, payload);
  }

  decryptScoped(
    userId: string,
    provider: string,
    credentialId: string,
    envelope: CodespaceCredentialEnvelope,
  ): ScopedCredentialPayload {
    const payload = this.decryptPayload(
      userId,
      provider,
      `scoped:${credentialId}`,
      envelope,
    ) as Partial<ScopedCredentialPayload>;
    if (
      (payload.token !== null && typeof payload.token !== "string") ||
      (payload.expiresAt !== null && !Number.isSafeInteger(payload.expiresAt))
    )
      throw new Error("Scoped credential decryption failed");
    return payload as ScopedCredentialPayload;
  }

  private decryptPayload(
    userId: string,
    provider: string,
    connectionId: string,
    envelope: CodespaceCredentialEnvelope,
  ): unknown {
    if (
      ![1, CURRENT_ENVELOPE_VERSION].includes(envelope.envelopeVersion) ||
      envelope.keyVersion !== this.keyVersion
    ) {
      throw new Error("Unsupported codespace credential envelope");
    }
    try {
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        this.key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(
        authenticatedContext(envelope.envelopeVersion, userId, provider, connectionId),
      );
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext) as unknown;
    } catch {
      throw new Error("Codespace credential decryption failed");
    }
  }
}
