export const WORKSPACE_PROVIDER_GITHUB = "github-codespaces" as const;

export type WorkspaceConnectionStatus =
  | "connecting"
  | "installation_required"
  | "connected"
  | "refresh_failed"
  | "revocation_pending"
  | "disconnected";

export type WorkspaceConnectionErrorCode =
  | "CONNECTION_REQUIRED"
  | "INSTALLATION_REQUIRED"
  | "REPOSITORY_NOT_ALLOWED"
  | "WORKSPACE_NOT_CONFIGURED"
  | "AUTH_REFRESH_FAILED"
  | "AUTH_GRANT_REVOCATION_REQUIRED"
  | "CREDENTIAL_UNREADABLE"
  | "AUTHORIZATION_FAILED";

export class WorkspaceConnectionError extends Error {
  constructor(
    public readonly code: WorkspaceConnectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceConnectionError";
  }
}

export interface WorkspaceCredentialPayload {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

export interface WorkspaceCredentialEnvelope {
  envelopeVersion: 1;
  keyVersion: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  generation: number;
}

export interface WorkspaceInstallationGrant {
  externalInstallationId: string;
  repositorySelection: "all" | "selected";
}

export interface WorkspaceRepositoryGrant {
  externalInstallationId: string;
  externalRepositoryId: string;
  fullName: string;
  private: boolean;
}

export interface WorkspaceConnectionSnapshot {
  id: string;
  userId: string;
  provider: string;
  externalAccountId: string;
  externalLogin: string;
  status: WorkspaceConnectionStatus;
  credentialGeneration: number;
  lastErrorCode: WorkspaceConnectionErrorCode | null;
  installations: WorkspaceInstallationGrant[];
  repositories: WorkspaceRepositoryGrant[];
}
