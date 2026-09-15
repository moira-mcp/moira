import crypto from "node:crypto";
import type { WorkspaceCredentialEnvelope, WorkspaceCredentialPayload } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = 1 as const;

function authenticatedContext(userId: string, provider: string, connectionId: string): Buffer {
  return Buffer.from(
    JSON.stringify(["moira-workspace-credential", userId, provider, connectionId]),
  );
}

export class WorkspaceCredentialVault {
  private readonly key: Buffer;

  constructor(
    keyHex: string,
    private readonly keyVersion: string,
  ) {
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
      throw new Error("Workspace credential vault key must be 64 hexadecimal characters");
    }
    this.key = Buffer.from(keyHex, "hex");
  }

  encrypt(
    userId: string,
    provider: string,
    connectionId: string,
    generation: number,
    payload: WorkspaceCredentialPayload,
  ): WorkspaceCredentialEnvelope {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(authenticatedContext(userId, provider, connectionId));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);

    return {
      envelopeVersion: ENVELOPE_VERSION,
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
    envelope: WorkspaceCredentialEnvelope,
  ): WorkspaceCredentialPayload {
    if (envelope.envelopeVersion !== ENVELOPE_VERSION || envelope.keyVersion !== this.keyVersion) {
      throw new Error("Unsupported workspace credential envelope");
    }
    try {
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        this.key,
        Buffer.from(envelope.iv, "base64url"),
      );
      decipher.setAAD(authenticatedContext(userId, provider, connectionId));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      const payload = JSON.parse(plaintext) as Partial<WorkspaceCredentialPayload>;
      if (
        typeof payload.accessToken !== "string" ||
        typeof payload.refreshToken !== "string" ||
        !Number.isSafeInteger(payload.accessTokenExpiresAt) ||
        !Number.isSafeInteger(payload.refreshTokenExpiresAt)
      ) {
        throw new Error("Invalid workspace credential payload");
      }
      return payload as WorkspaceCredentialPayload;
    } catch {
      throw new Error("Workspace credential decryption failed");
    }
  }
}
