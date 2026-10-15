import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export interface WorkspaceAgentBinding {
  userId: string;
  resourceId: string;
  resourceGeneration: number;
  authorizationGeneration: number;
  environmentIdentity: string;
}

export interface WorkspaceAgentCredentialRecord extends WorkspaceAgentBinding {
  credentialDigest: string;
  expiresAt: number | null;
  createdAt: number;
}

/** Authentication state only; this repository never records requests or results. */
export class WorkspaceAuthRepository {
  constructor(private readonly db: Database.Database) {}

  issue(
    binding: WorkspaceAgentBinding,
    expiresAt: number | null,
    trustedCredential?: string,
  ): string {
    if (
      !binding.environmentIdentity ||
      binding.environmentIdentity.length > 256 ||
      !Number.isSafeInteger(binding.resourceGeneration) ||
      binding.resourceGeneration < 1 ||
      !Number.isSafeInteger(binding.authorizationGeneration) ||
      binding.authorizationGeneration < 1 ||
      (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()))
    )
      throw new Error("Invalid workspace credential binding");
    const credential = trustedCredential ?? randomBytes(32).toString("base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential))
      throw new Error("Invalid trusted workspace credential");
    this.db
      .prepare(
        `INSERT INTO workspaceAgentCredential
      (resourceId,userId,credentialDigest,resourceGeneration,authorizationGeneration,environmentIdentity,expiresAt,createdAt)
      VALUES (@resourceId,@userId,@credentialDigest,@resourceGeneration,@authorizationGeneration,@environmentIdentity,@expiresAt,@createdAt)
      ON CONFLICT(resourceId) DO UPDATE SET userId=excluded.userId,
        credentialDigest=excluded.credentialDigest,resourceGeneration=excluded.resourceGeneration,
        authorizationGeneration=excluded.authorizationGeneration,environmentIdentity=excluded.environmentIdentity,
        expiresAt=excluded.expiresAt,createdAt=excluded.createdAt`,
      )
      .run({
        ...binding,
        expiresAt,
        createdAt: Date.now(),
        credentialDigest: this.digest(credential),
      });
    return credential;
  }

  authenticate(credential: string): WorkspaceAgentCredentialRecord {
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error("Workspace credential refused");
    const record = this.db
      .prepare("SELECT * FROM workspaceAgentCredential WHERE credentialDigest=?")
      .get(this.digest(credential)) as WorkspaceAgentCredentialRecord | undefined;
    if (!record || (record.expiresAt !== null && record.expiresAt <= Date.now()))
      throw new Error("Workspace credential refused");
    return record;
  }

  getOwned(userId: string, resourceId: string): WorkspaceAgentCredentialRecord | null {
    return (
      (this.db
        .prepare("SELECT * FROM workspaceAgentCredential WHERE userId=? AND resourceId=?")
        .get(userId, resourceId) as WorkspaceAgentCredentialRecord | undefined) ?? null
    );
  }

  revoke(resourceId: string): void {
    this.db.prepare("DELETE FROM workspaceAgentCredential WHERE resourceId=?").run(resourceId);
  }

  private digest(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
