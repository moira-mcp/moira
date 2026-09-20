export const CODESPACE_PROVIDER_GITHUB = "github-codespaces" as const;

export type CodespaceConnectionStatus =
  | "connecting"
  | "installation_required"
  | "connected"
  | "refresh_failed"
  | "revocation_pending"
  | "disconnected";

export type CodespaceConnectionErrorCode =
  | "CONNECTION_REQUIRED"
  | "INSTALLATION_REQUIRED"
  | "REPOSITORY_NOT_ALLOWED"
  | "CODESPACE_NOT_CONFIGURED"
  | "AUTH_REFRESH_FAILED"
  | "AUTH_GRANT_REVOCATION_REQUIRED"
  | "CREDENTIAL_UNREADABLE"
  | "AUTHORIZATION_FAILED";

export class CodespaceConnectionError extends Error {
  constructor(
    public readonly code: CodespaceConnectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodespaceConnectionError";
  }
}

export interface CodespaceCredentialPayload {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

export interface CodespaceCredentialEnvelope {
  envelopeVersion: 1 | 2;
  keyVersion: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  generation: number;
}

export interface CodespaceInstallationGrant {
  externalInstallationId: string;
  repositorySelection: "all" | "selected";
}

export interface CodespaceRepositoryGrant {
  externalInstallationId: string;
  externalRepositoryId: string;
  fullName: string;
  private: boolean;
}

export interface CodespaceConnectionSnapshot {
  id: string;
  userId: string;
  provider: string;
  externalAccountId: string;
  externalLogin: string;
  status: CodespaceConnectionStatus;
  credentialGeneration: number;
  lastErrorCode: CodespaceConnectionErrorCode | null;
  installations: CodespaceInstallationGrant[];
  repositories: CodespaceRepositoryGrant[];
}
