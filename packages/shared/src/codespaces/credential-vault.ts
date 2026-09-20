import crypto from "node:crypto";
import type { CodespaceCredentialEnvelope, CodespaceCredentialPayload } from "./types.js";

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
      const payload = JSON.parse(plaintext) as Partial<CodespaceCredentialPayload>;
      if (
        typeof payload.accessToken !== "string" ||
        typeof payload.refreshToken !== "string" ||
        !Number.isSafeInteger(payload.accessTokenExpiresAt) ||
        !Number.isSafeInteger(payload.refreshTokenExpiresAt)
      ) {
        throw new Error("Invalid codespace credential payload");
      }
      return payload as CodespaceCredentialPayload;
    } catch {
      throw new Error("Codespace credential decryption failed");
    }
  }
}
