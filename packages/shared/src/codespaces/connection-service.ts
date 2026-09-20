import { randomBytes, randomUUID } from "node:crypto";
import type { CodespaceGitHubConfigStatus } from "./github-app-config.js";
import { CodespaceCredentialVault } from "./credential-vault.js";
import {
  CodespaceConnectionRepository,
  digestCodespaceAuthorizationValue,
} from "./connection-repository.js";
import {
  CODESPACE_PROVIDER_GITHUB,
  CodespaceConnectionError,
  type CodespaceConnectionSnapshot,
  type CodespaceCredentialPayload,
  type CodespaceInstallationGrant,
  type CodespaceRepositoryGrant,
} from "./types.js";

export interface GitHubCodespaceUser {
  id: string;
  login: string;
}

export interface GitHubCodespaceInstallation {
  id: string;
  accountId: string;
  accountLogin: string;
  targetType: string;
  repositorySelection: "all" | "selected";
}

export interface GitHubCodespaceRepository {
  id: string;
  fullName: string;
  private: boolean;
}

export type GitHubCodespaceTokenResponse = CodespaceCredentialPayload;

export interface GitHubCodespaceClient {
  exchangeCode(code: string): Promise<GitHubCodespaceTokenResponse>;
  refreshToken(refreshToken: string): Promise<GitHubCodespaceTokenResponse>;
  getUser(accessToken: string): Promise<GitHubCodespaceUser>;
  listInstallations(accessToken: string): Promise<GitHubCodespaceInstallation[]>;
  listInstallationRepositories(
    accessToken: string,
    installationId: string,
  ): Promise<GitHubCodespaceRepository[]>;
  revokeToken(accessToken: string): Promise<void>;
  revokeGrant(accessToken: string): Promise<void>;
}

export interface CodespaceConnectionAuditEvent {
  action: "start" | "complete" | "refresh_failed" | "disconnect";
  userId: string;
  provider: typeof CODESPACE_PROVIDER_GITHUB;
  connectionId?: string;
  outcome: string;
}

export interface CodespaceConnectionView {
  state:
    | "disabled"
    | "configuration_error"
    | "connection_required"
    | "connecting"
    | "installation_required"
    | "connected"
    | "refresh_failed"
    | "revocation_pending"
    | "disconnected";
  reason: string | null;
  settingsUrl: string;
  installationUrl: string | null;
  account: { id: string; login: string } | null;
  installations: CodespaceInstallationGrant[];
  repositories: Array<
    Pick<CodespaceRepositoryGrant, "externalRepositoryId" | "fullName" | "private">
  >;
  /** Present on refreshed read surfaces; true means the last saved grant snapshot was retained. */
  repositoriesStale?: boolean;
  canConnect: boolean;
  canDisconnect: boolean;
}

export interface CodespaceConnectionServiceDependencies {
  repository: CodespaceConnectionRepository;
  config: () => CodespaceGitHubConfigStatus;
  client: (
    config: Extract<CodespaceGitHubConfigStatus, { state: "available" }>,
  ) => GitHubCodespaceClient;
  /** Recognizes failures produced by the provider client; internal faults must remain visible. */
  isProviderFailure?: (error: unknown) => boolean;
  now?: () => number;
  randomState?: () => string;
  randomId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  audit?: (event: CodespaceConnectionAuditEvent) => Promise<void> | void;
  beforeDisconnect?: (userId: string) => Promise<void>;
  afterConnect?: (userId: string) => Promise<void>;
}

const AUTHORIZATION_STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_LEASE_MS = 30_000;
const REFRESH_EARLY_MS = 60_000;

function requireAvailableConfig(
  config: CodespaceGitHubConfigStatus,
): Extract<CodespaceGitHubConfigStatus, { state: "available" }> {
  if (config.state !== "available") {
    throw new CodespaceConnectionError(
      "CODESPACE_NOT_CONFIGURED",
      config.state === "disabled"
        ? "GitHub codespaces are not configured"
        : "GitHub codespace configuration is invalid",
    );
  }
  return config;
}

function validateExternalId(value: string): string {
  if (!/^[1-9][0-9]{0,39}$/.test(value)) {
    throw new CodespaceConnectionError(
      "AUTHORIZATION_FAILED",
      "GitHub returned an invalid identity",
    );
  }
  return value;
}

function validateTokenPayload(payload: GitHubCodespaceTokenResponse, now: number): void {
  if (
    !payload.accessToken ||
    !payload.refreshToken ||
    !payload.accessToken.startsWith("ghu_") ||
    !payload.refreshToken.startsWith("ghr_") ||
    !Number.isSafeInteger(payload.accessTokenExpiresAt) ||
    !Number.isSafeInteger(payload.refreshTokenExpiresAt) ||
    payload.accessTokenExpiresAt <= now ||
    payload.refreshTokenExpiresAt <= payload.accessTokenExpiresAt
  ) {
    throw new CodespaceConnectionError(
      "AUTHORIZATION_FAILED",
      "GitHub App did not return an expiring user credential",
    );
  }
}

function mapSnapshot(
  snapshot: CodespaceConnectionSnapshot | null,
  settingsUrl: string,
): CodespaceConnectionView {
  if (!snapshot) {
    return {
      state: "connection_required",
      reason: "CONNECTION_REQUIRED",
      settingsUrl,
      installationUrl: null,
      account: null,
      installations: [],
      repositories: [],
      canConnect: true,
      canDisconnect: false,
    };
  }
  return {
    state: snapshot.status,
    reason:
      snapshot.lastErrorCode === "CREDENTIAL_UNREADABLE"
        ? "CREDENTIAL_UNREADABLE"
        : snapshot.lastErrorCode === "AUTH_GRANT_REVOCATION_REQUIRED"
          ? "AUTH_GRANT_REVOCATION_REQUIRED"
          : snapshot.status === "installation_required"
            ? "INSTALLATION_REQUIRED"
            : snapshot.status === "refresh_failed"
              ? "AUTH_REFRESH_FAILED"
              : snapshot.status === "revocation_pending"
                ? "REVOCATION_PENDING"
                : snapshot.lastErrorCode,
    settingsUrl,
    installationUrl: null,
    account: { id: snapshot.externalAccountId, login: snapshot.externalLogin },
    installations: snapshot.installations,
    repositories: snapshot.repositories.map(
      ({ externalRepositoryId, fullName, private: isPrivate }) => ({
        externalRepositoryId,
        fullName,
        private: isPrivate,
      }),
    ),
    canConnect:
      !["CREDENTIAL_UNREADABLE", "AUTH_GRANT_REVOCATION_REQUIRED"].includes(
        snapshot.lastErrorCode ?? "",
      ) &&
      ["connecting", "installation_required", "refresh_failed", "disconnected"].includes(
        snapshot.status,
      ),
    canDisconnect:
      snapshot.lastErrorCode !== "AUTH_GRANT_REVOCATION_REQUIRED" &&
      !["disconnected", "connecting"].includes(snapshot.status),
  };
}

function pendingRevocationView(
  settingsUrl: string,
  reason: "REVOCATION_PENDING" | "CREDENTIAL_UNREADABLE" = "REVOCATION_PENDING",
): CodespaceConnectionView {
  return {
    state: "revocation_pending",
    reason,
    settingsUrl,
    installationUrl: null,
    account: null,
    installations: [],
    repositories: [],
    canConnect: false,
    canDisconnect: reason === "REVOCATION_PENDING",
  };
}

/** How stale the grants snapshot may be before a read re-enumerates it. */
const GRANTS_MAX_AGE_MS = 10 * 60_000;

export class CodespaceConnectionService {
  private readonly now: () => number;
  private readonly randomState: () => string;
  private readonly randomId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly refreshes = new Map<string, Promise<string>>();
  private readonly grantRefreshes = new Map<
    string,
    Promise<{ refreshed: boolean; stale: boolean }>
  >();
  private readonly failedGrantRefreshes = new Map<string, number>();

  constructor(private readonly dependencies: CodespaceConnectionServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.randomState = dependencies.randomState ?? (() => randomBytes(32).toString("base64url"));
    this.randomId = dependencies.randomId ?? randomUUID;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private revocationContext(id: string): string {
    return `pending-revocation:${id}`;
  }

  private retainCredentialForRevocation(
    userId: string,
    config: Extract<CodespaceGitHubConfigStatus, { state: "available" }>,
    credential: CodespaceCredentialPayload,
  ): string {
    const id = this.randomId();
    const vault = new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion);
    const envelope = vault.encrypt(
      userId,
      CODESPACE_PROVIDER_GITHUB,
      this.revocationContext(id),
      1,
      credential,
    );
    this.dependencies.repository.storePendingRevocation({
      id,
      userId,
      provider: CODESPACE_PROVIDER_GITHUB,
      envelope,
      now: this.now(),
    });
    return id;
  }

  private async revokePendingCredential(
    userId: string,
    config: Extract<CodespaceGitHubConfigStatus, { state: "available" }>,
    id: string,
  ): Promise<void> {
    const pending = this.dependencies.repository
      .getPendingRevocations(userId, CODESPACE_PROVIDER_GITHUB)
      .find((candidate) => candidate.id === id);
    if (!pending) return;
    const credential = new CodespaceCredentialVault(
      config.vaultKeyHex,
      config.vaultKeyVersion,
    ).decrypt(
      userId,
      CODESPACE_PROVIDER_GITHUB,
      this.revocationContext(pending.id),
      pending.envelope,
    );
    await this.dependencies.client(config).revokeToken(credential.accessToken);
    this.dependencies.repository.deletePendingRevocation(
      userId,
      CODESPACE_PROVIDER_GITHUB,
      pending.id,
    );
  }

  private async retainAndRevokeCredential(
    userId: string,
    config: Extract<CodespaceGitHubConfigStatus, { state: "available" }>,
    credential: CodespaceCredentialPayload,
  ): Promise<void> {
    const id = this.retainCredentialForRevocation(userId, config, credential);
    await this.revokePendingCredential(userId, config, id);
  }

  private async drainPendingRevocations(
    userId: string,
    config: Extract<CodespaceGitHubConfigStatus, { state: "available" }>,
  ): Promise<void> {
    for (const pending of this.dependencies.repository.getPendingRevocations(
      userId,
      CODESPACE_PROVIDER_GITHUB,
    )) {
      await this.revokePendingCredential(userId, config, pending.id);
    }
  }

  private async failExpiredRefreshLease(
    userId: string,
    connectionId: string,
    expectedGeneration: number,
  ): Promise<boolean> {
    const failed = this.dependencies.repository.markExpiredRefreshFailed({
      userId,
      connectionId,
      expectedGeneration,
      now: this.now(),
    });
    if (failed) {
      await this.dependencies.audit?.({
        action: "refresh_failed",
        userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        connectionId,
        outcome: "refresh_worker_abandoned",
      });
    }
    return failed;
  }

  private refreshFailure(userId: string, connectionId: string): CodespaceConnectionError {
    const snapshot = this.dependencies.repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    if (
      snapshot?.id === connectionId &&
      snapshot.lastErrorCode === "AUTH_GRANT_REVOCATION_REQUIRED"
    ) {
      return new CodespaceConnectionError(
        "AUTH_GRANT_REVOCATION_REQUIRED",
        "Revoke the GitHub App grant externally, then confirm recovery in Moira settings",
      );
    }
    return new CodespaceConnectionError(
      "AUTH_REFRESH_FAILED",
      "Reconnect GitHub in Moira settings",
    );
  }

  private hasUnreadableCredential(
    userId: string,
    config: Extract<CodespaceGitHubConfigStatus, { state: "available" }>,
  ): boolean {
    const vault = new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion);
    const active = this.dependencies.repository.getCredential(userId, CODESPACE_PROVIDER_GITHUB);
    try {
      if (active) {
        vault.decrypt(userId, CODESPACE_PROVIDER_GITHUB, active.connection.id, active.envelope);
      }
      for (const pending of this.dependencies.repository.getPendingRevocations(
        userId,
        CODESPACE_PROVIDER_GITHUB,
      )) {
        vault.decrypt(
          userId,
          CODESPACE_PROVIDER_GITHUB,
          this.revocationContext(pending.id),
          pending.envelope,
        );
      }
      return false;
    } catch {
      return true;
    }
  }

  getStatus(userId: string): CodespaceConnectionView {
    const config = this.dependencies.config();
    if (config.state !== "available") {
      const snapshot = this.dependencies.repository.getConnection(
        userId,
        CODESPACE_PROVIDER_GITHUB,
      );
      if (
        snapshot?.lastErrorCode === "CREDENTIAL_UNREADABLE" ||
        snapshot?.lastErrorCode === "AUTH_GRANT_REVOCATION_REQUIRED"
      ) {
        const view = mapSnapshot(snapshot, config.settingsUrl);
        view.state =
          snapshot.status === "revocation_pending" ? "revocation_pending" : "refresh_failed";
        view.reason = snapshot.lastErrorCode;
        view.installationUrl = null;
        view.canConnect = false;
        view.canDisconnect = false;
        return view;
      }
      return {
        state: config.state === "disabled" ? "disabled" : "configuration_error",
        reason: config.reason,
        settingsUrl: config.settingsUrl,
        installationUrl: null,
        account: null,
        installations: [],
        repositories: [],
        canConnect: false,
        canDisconnect: false,
      };
    }
    let snapshot = this.dependencies.repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    const unreadable = this.hasUnreadableCredential(userId, config);
    if (unreadable) {
      if (!snapshot || snapshot.status === "disconnected") {
        return pendingRevocationView(config.settingsUrl, "CREDENTIAL_UNREADABLE");
      }
      const view = mapSnapshot(snapshot, config.settingsUrl);
      view.state =
        snapshot.status === "revocation_pending" ? "revocation_pending" : "refresh_failed";
      view.reason = "CREDENTIAL_UNREADABLE";
      view.installationUrl = null;
      view.canConnect = false;
      view.canDisconnect = false;
      return view;
    }
    if (snapshot?.lastErrorCode === "CREDENTIAL_UNREADABLE") {
      snapshot = { ...snapshot, lastErrorCode: null };
    }
    if (snapshot?.lastErrorCode === "AUTH_GRANT_REVOCATION_REQUIRED") {
      if (
        this.dependencies.repository.isRefreshSubmissionInFlight(
          userId,
          CODESPACE_PROVIDER_GITHUB,
          this.now(),
        )
      ) {
        return mapSnapshot({ ...snapshot, lastErrorCode: null }, config.settingsUrl);
      }
      const view = mapSnapshot(snapshot, config.settingsUrl);
      view.state = "refresh_failed";
      view.reason = "AUTH_GRANT_REVOCATION_REQUIRED";
      view.installationUrl = null;
      view.canConnect = false;
      view.canDisconnect = false;
      return view;
    }
    if (
      (!snapshot || snapshot.status === "disconnected") &&
      this.dependencies.repository.getPendingRevocations(userId, CODESPACE_PROVIDER_GITHUB).length >
        0
    ) {
      return pendingRevocationView(config.settingsUrl);
    }
    const view = mapSnapshot(snapshot, config.settingsUrl);
    view.installationUrl = view.state === "installation_required" ? config.installationUrl : null;
    return view;
  }

  async beginAuthorization(userId: string, sessionToken: string): Promise<string> {
    const config = requireAvailableConfig(this.dependencies.config());
    let current = this.dependencies.repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    if (this.hasUnreadableCredential(userId, config)) {
      throw new CodespaceConnectionError(
        "CREDENTIAL_UNREADABLE",
        "Confirm external GitHub revocation in Moira settings",
      );
    }
    if (current?.lastErrorCode === "CREDENTIAL_UNREADABLE") {
      this.dependencies.repository.clearUnreadableCredentialFailure(userId, current.id, this.now());
      current = this.dependencies.repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    }
    if (
      current?.lastErrorCode === "AUTH_GRANT_REVOCATION_REQUIRED" &&
      !this.dependencies.repository.isRefreshSubmissionInFlight(
        userId,
        CODESPACE_PROVIDER_GITHUB,
        this.now(),
      )
    ) {
      throw new CodespaceConnectionError(
        "AUTH_GRANT_REVOCATION_REQUIRED",
        "Revoke the GitHub App grant externally, then confirm recovery in Moira settings",
      );
    }
    if (current?.status === "connected" || current?.status === "revocation_pending") {
      throw new CodespaceConnectionError(
        "AUTHORIZATION_FAILED",
        current.status === "connected"
          ? "Disconnect GitHub before changing the connected account"
          : "GitHub disconnect is still pending",
      );
    }
    try {
      await this.drainPendingRevocations(userId, config);
    } catch {
      throw new CodespaceConnectionError(
        "AUTH_REFRESH_FAILED",
        "Pending GitHub access must be revoked in Moira settings",
      );
    }
    const state = this.randomState();
    const now = this.now();
    this.dependencies.repository.storeAuthorizationState({
      stateHash: digestCodespaceAuthorizationValue(state),
      userId,
      sessionTokenHash: digestCodespaceAuthorizationValue(sessionToken),
      provider: CODESPACE_PROVIDER_GITHUB,
      redirectPath: config.settingsUrl,
      expiresAt: now + AUTHORIZATION_STATE_TTL_MS,
      now,
    });
    await this.dependencies.audit?.({
      action: "start",
      userId,
      provider: CODESPACE_PROVIDER_GITHUB,
      outcome: "redirected",
    });
    const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
    authorizationUrl.searchParams.set("client_id", config.clientId);
    authorizationUrl.searchParams.set("redirect_uri", config.callbackUrl);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("allow_signup", "false");
    authorizationUrl.searchParams.set("prompt", "select_account");
    return authorizationUrl.toString();
  }

  async completeAuthorization(input: {
    userId: string;
    sessionToken: string;
    state: string;
    code: string;
  }): Promise<CodespaceConnectionView> {
    const config = requireAvailableConfig(this.dependencies.config());
    if (
      !/^[A-Za-z0-9_-]{20,512}$/.test(input.state) ||
      !/^[A-Za-z0-9_-]{6,512}$/.test(input.code)
    ) {
      throw new CodespaceConnectionError("AUTHORIZATION_FAILED", "GitHub authorization failed");
    }
    const consumed = this.dependencies.repository.consumeAuthorizationState({
      stateHash: digestCodespaceAuthorizationValue(input.state),
      userId: input.userId,
      sessionTokenHash: digestCodespaceAuthorizationValue(input.sessionToken),
      provider: CODESPACE_PROVIDER_GITHUB,
      now: this.now(),
    });
    if (!consumed) {
      throw new CodespaceConnectionError("AUTHORIZATION_FAILED", "GitHub authorization failed");
    }

    const client = this.dependencies.client(config);
    const previous = this.dependencies.repository.getCredential(
      input.userId,
      CODESPACE_PROVIDER_GITHUB,
    );
    let previousCredential: CodespaceCredentialPayload | null = null;
    if (previous) {
      try {
        previousCredential = new CodespaceCredentialVault(
          config.vaultKeyHex,
          config.vaultKeyVersion,
        ).decrypt(
          input.userId,
          CODESPACE_PROVIDER_GITHUB,
          previous.connection.id,
          previous.envelope,
        );
        await this.retainAndRevokeCredential(input.userId, config, previousCredential);
      } catch {
        this.dependencies.repository.markCredentialFailed(
          input.userId,
          previous.connection.id,
          this.now(),
        );
        throw new CodespaceConnectionError(
          "AUTH_REFRESH_FAILED",
          "Reconnect GitHub in Moira settings",
        );
      }
    }

    let token: GitHubCodespaceTokenResponse | null = null;
    let connectionId: string | null = null;
    let installationGrants: CodespaceInstallationGrant[] = [];
    try {
      token = await client.exchangeCode(input.code);
      const now = this.now();
      validateTokenPayload(token, now);
      if (previousCredential?.accessToken === token.accessToken) {
        throw new CodespaceConnectionError(
          "AUTHORIZATION_FAILED",
          "GitHub returned a superseded credential",
        );
      }
      const githubUser = await client.getUser(token.accessToken);
      const externalAccountId = validateExternalId(githubUser.id);
      if (!/^[A-Za-z0-9-]{1,39}$/.test(githubUser.login)) {
        throw new CodespaceConnectionError(
          "AUTHORIZATION_FAILED",
          "GitHub returned an invalid identity",
        );
      }
      const installations = (await client.listInstallations(token.accessToken)).filter(
        (installation) =>
          installation.targetType === "User" &&
          validateExternalId(installation.accountId) === externalAccountId,
      );
      installationGrants = [];
      const repositoryGrants: CodespaceRepositoryGrant[] = [];
      for (const installation of installations) {
        const installationId = validateExternalId(installation.id);
        installationGrants.push({
          externalInstallationId: installationId,
          repositorySelection: installation.repositorySelection,
        });
        const repositories = await client.listInstallationRepositories(
          token.accessToken,
          installationId,
        );
        for (const repository of repositories) {
          const repositoryId = validateExternalId(repository.id);
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.fullName)) {
            throw new CodespaceConnectionError(
              "AUTHORIZATION_FAILED",
              "GitHub returned an invalid repository",
            );
          }
          repositoryGrants.push({
            externalInstallationId: installationId,
            externalRepositoryId: repositoryId,
            fullName: repository.fullName,
            private: repository.private,
          });
        }
      }
      connectionId = this.dependencies.repository.reserveConnection({
        userId: input.userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        externalAccountId,
        externalLogin: githubUser.login,
        now,
      });
      const generation = (previous?.envelope.generation ?? 0) + 1;
      const vault = new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion);
      const envelope = vault.encrypt(
        input.userId,
        CODESPACE_PROVIDER_GITHUB,
        connectionId,
        generation,
        token,
      );
      this.dependencies.repository.completeConnection({
        connectionId,
        userId: input.userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        externalAccountId,
        externalLogin: githubUser.login,
        status: installationGrants.length > 0 ? "connected" : "installation_required",
        envelope,
        installations: installationGrants,
        repositories: repositoryGrants,
        now,
      });
    } catch (error) {
      if (token) {
        try {
          await this.retainAndRevokeCredential(input.userId, config, token);
        } catch {
          // The encrypted pending row is intentionally retained for a later exact retry.
        }
      }
      if (connectionId) {
        this.dependencies.repository.markCredentialFailed(input.userId, connectionId, this.now());
      }
      if (error instanceof CodespaceConnectionError) throw error;
      throw new CodespaceConnectionError("AUTHORIZATION_FAILED", "GitHub authorization failed");
    }
    if (!connectionId) {
      throw new CodespaceConnectionError("AUTHORIZATION_FAILED", "GitHub authorization failed");
    }
    let rebindPending = false;
    try {
      await this.dependencies.afterConnect?.(input.userId);
    } catch {
      // The new credential remains valid. Existing codespaces stay generation-fenced
      // until an exact provider recheck succeeds on a later reconciliation.
      rebindPending = true;
    }
    await this.dependencies.audit?.({
      action: "complete",
      userId: input.userId,
      provider: CODESPACE_PROVIDER_GITHUB,
      connectionId,
      outcome:
        installationGrants.length === 0
          ? "installation_required"
          : rebindPending
            ? "connected_rebind_pending"
            : "connected",
    });
    return this.getStatus(input.userId);
  }

  /**
   * Bring the installation and repository grants up to date, bounded by age.
   *
   * The snapshot used to be written only when the user authorized, so a repository added to the
   * installation afterwards stayed invisible until they reconnected — with nothing in the product
   * saying so. A read older than the bound re-enumerates and writes back; a provider that cannot be
   * reached leaves the stored snapshot in place and says it may be stale, because yesterday's list is
   * a better answer than an error.
   */
  async refreshGrants(
    userId: string,
    options: { force?: boolean } = {},
  ): Promise<{ refreshed: boolean; stale: boolean }> {
    const config = this.dependencies.config();
    if (config.state !== "available") return { refreshed: false, stale: false };
    const snapshot = this.dependencies.repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    if (
      !snapshot ||
      (snapshot.status !== "connected" && snapshot.status !== "installation_required")
    ) {
      return { refreshed: false, stale: false };
    }
    const grantSnapshot = this.dependencies.repository.grantSnapshot(snapshot.id);
    if (!grantSnapshot) return { refreshed: false, stale: false };
    const refreshedAt = grantSnapshot.refreshedAt;
    const age = refreshedAt === null ? Number.POSITIVE_INFINITY : this.now() - refreshedAt;
    if (!options.force && age < GRANTS_MAX_AGE_MS) return { refreshed: false, stale: false };
    const failedAt = this.failedGrantRefreshes.get(snapshot.id);
    if (!options.force && failedAt !== undefined && this.now() - failedAt < GRANTS_MAX_AGE_MS) {
      return { refreshed: false, stale: true };
    }
    const currentRefresh = this.grantRefreshes.get(snapshot.id);
    if (currentRefresh) return currentRefresh;
    const refresh = this.performGrantRefresh(
      userId,
      snapshot,
      grantSnapshot.version,
      config,
    ).finally(() => {
      this.grantRefreshes.delete(snapshot.id);
    });
    this.grantRefreshes.set(snapshot.id, refresh);
    return refresh;
  }

  private async performGrantRefresh(
    userId: string,
    snapshot: CodespaceConnectionSnapshot,
    expectedGrantsVersion: number,
    config: Extract<CodespaceGitHubConfigStatus, { state: "available" }>,
  ): Promise<{ refreshed: boolean; stale: boolean }> {
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken(userId, { allowInstallationRequired: true });
    } catch (error) {
      if (!(error instanceof CodespaceConnectionError)) throw error;
      this.failedGrantRefreshes.set(snapshot.id, this.now());
      return { refreshed: false, stale: true };
    }
    const current = this.dependencies.repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    if (
      !current ||
      current.id !== snapshot.id ||
      (current.status !== "connected" && current.status !== "installation_required")
    ) {
      return { refreshed: false, stale: false };
    }

    const client = this.dependencies.client(config);
    let installationGrants: CodespaceInstallationGrant[];
    let repositoryGrants: CodespaceRepositoryGrant[];
    try {
      const identity = await client.getUser(accessToken);
      const externalAccountId = validateExternalId(identity.id);
      const installations = (await client.listInstallations(accessToken)).filter(
        (installation) =>
          installation.targetType === "User" &&
          validateExternalId(installation.accountId) === externalAccountId,
      );
      installationGrants = [];
      repositoryGrants = [];
      for (const installation of installations) {
        const externalInstallationId = validateExternalId(installation.id);
        installationGrants.push({
          externalInstallationId,
          repositorySelection: installation.repositorySelection,
        });
        for (const repository of await client.listInstallationRepositories(
          accessToken,
          externalInstallationId,
        )) {
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.fullName)) {
            throw new CodespaceConnectionError(
              "AUTHORIZATION_FAILED",
              "GitHub returned an invalid repository name",
            );
          }
          repositoryGrants.push({
            externalInstallationId,
            externalRepositoryId: validateExternalId(repository.id),
            fullName: repository.fullName,
            private: repository.private,
          });
        }
      }
    } catch (error) {
      if (
        !(error instanceof CodespaceConnectionError) &&
        this.dependencies.isProviderFailure?.(error) !== true
      ) {
        throw error;
      }
      // The stored snapshot stands. Nothing about the connection is marked failed here: a listing that
      // could not be refreshed is not a broken credential, and treating it as one would disconnect a
      // user because GitHub was briefly unreachable.
      this.failedGrantRefreshes.set(snapshot.id, this.now());
      return { refreshed: false, stale: true };
    }

    const replaced = this.dependencies.repository.replaceGrants({
      connectionId: snapshot.id,
      userId,
      provider: CODESPACE_PROVIDER_GITHUB,
      expectedCredentialGeneration: current.credentialGeneration,
      expectedGrantsVersion,
      installations: installationGrants,
      repositories: repositoryGrants,
      now: this.now(),
    });
    if (!replaced) {
      const latest = this.dependencies.repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
      if (
        !latest ||
        latest.id !== snapshot.id ||
        (latest.status !== "connected" && latest.status !== "installation_required")
      ) {
        return { refreshed: false, stale: false };
      }
      const latestGrantSnapshot = this.dependencies.repository.grantSnapshot(latest.id);
      return {
        refreshed: false,
        stale:
          latestGrantSnapshot === null ||
          latestGrantSnapshot.refreshedAt === null ||
          this.now() - latestGrantSnapshot.refreshedAt >= GRANTS_MAX_AGE_MS,
      };
    }
    this.failedGrantRefreshes.delete(snapshot.id);
    return { refreshed: true, stale: false };
  }

  async getAccessToken(
    userId: string,
    options: { allowInstallationRequired?: boolean } = {},
  ): Promise<string> {
    const config = requireAvailableConfig(this.dependencies.config());
    const stored = this.dependencies.repository.getCredential(userId, CODESPACE_PROVIDER_GITHUB);
    if (!stored || stored.connection.status === "disconnected") {
      throw new CodespaceConnectionError("CONNECTION_REQUIRED", "Connect GitHub in Moira settings");
    }
    if (this.hasUnreadableCredential(userId, config)) {
      this.dependencies.repository.markCredentialFailed(
        userId,
        stored.connection.id,
        this.now(),
        "CREDENTIAL_UNREADABLE",
      );
      await this.dependencies.audit?.({
        action: "refresh_failed",
        userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        connectionId: stored.connection.id,
        outcome: "credential_unreadable",
      });
      throw new CodespaceConnectionError(
        "CREDENTIAL_UNREADABLE",
        "Revoke GitHub access externally, then confirm recovery in Moira settings",
      );
    }
    if (
      stored.connection.lastErrorCode === "AUTH_GRANT_REVOCATION_REQUIRED" &&
      !this.dependencies.repository.isRefreshSubmissionInFlight(
        userId,
        CODESPACE_PROVIDER_GITHUB,
        this.now(),
      )
    ) {
      throw new CodespaceConnectionError(
        "AUTH_GRANT_REVOCATION_REQUIRED",
        "Revoke the GitHub App grant externally, then confirm recovery in Moira settings",
      );
    }
    if (
      stored.connection.status === "installation_required" &&
      options.allowInstallationRequired !== true
    ) {
      throw new CodespaceConnectionError(
        "INSTALLATION_REQUIRED",
        "Install the GitHub App in Moira settings",
      );
    }
    if (
      stored.connection.status !== "connected" &&
      !(
        options.allowInstallationRequired === true &&
        stored.connection.status === "installation_required"
      )
    ) {
      throw new CodespaceConnectionError(
        "AUTH_REFRESH_FAILED",
        "Reconnect GitHub in Moira settings",
      );
    }
    const vault = new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion);
    let credential: CodespaceCredentialPayload;
    try {
      credential = vault.decrypt(
        userId,
        CODESPACE_PROVIDER_GITHUB,
        stored.connection.id,
        stored.envelope,
      );
    } catch {
      this.dependencies.repository.markCredentialFailed(
        userId,
        stored.connection.id,
        this.now(),
        "CREDENTIAL_UNREADABLE",
      );
      await this.dependencies.audit?.({
        action: "refresh_failed",
        userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        connectionId: stored.connection.id,
        outcome: "credential_unreadable",
      });
      throw new CodespaceConnectionError(
        "CREDENTIAL_UNREADABLE",
        "Revoke GitHub access externally, then confirm recovery in Moira settings",
      );
    }
    if (credential.accessTokenExpiresAt > this.now() + REFRESH_EARLY_MS) {
      return credential.accessToken;
    }
    const existing = this.refreshes.get(stored.connection.id);
    if (existing) return existing;
    const refresh = this.refreshCredential(
      userId,
      stored.connection.id,
      config,
      options.allowInstallationRequired === true,
    ).finally(() => {
      this.refreshes.delete(stored.connection.id);
    });
    this.refreshes.set(stored.connection.id, refresh);
    return refresh;
  }

  private async refreshCredential(
    userId: string,
    connectionId: string,
    config: Extract<CodespaceGitHubConfigStatus, { state: "available" }>,
    allowInstallationRequired = false,
  ): Promise<string> {
    const current = this.dependencies.repository.getCredential(userId, CODESPACE_PROVIDER_GITHUB);
    if (
      !current ||
      current.connection.id !== connectionId ||
      (current.connection.status !== "connected" &&
        !(allowInstallationRequired && current.connection.status === "installation_required"))
    ) {
      throw new CodespaceConnectionError(
        "AUTH_REFRESH_FAILED",
        "Reconnect GitHub in Moira settings",
      );
    }
    const vault = new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion);
    const credential = vault.decrypt(
      userId,
      CODESPACE_PROVIDER_GITHUB,
      connectionId,
      current.envelope,
    );
    if (credential.accessTokenExpiresAt > this.now() + REFRESH_EARLY_MS) {
      return credential.accessToken;
    }
    const leaseId = this.randomId();
    const now = this.now();
    const claimed = this.dependencies.repository.claimRefresh({
      userId,
      connectionId,
      expectedGeneration: current.envelope.generation,
      leaseId,
      now,
      leaseExpiresAt: now + REFRESH_LEASE_MS,
    });
    if (!claimed) {
      if (await this.failExpiredRefreshLease(userId, connectionId, current.envelope.generation)) {
        throw this.refreshFailure(userId, connectionId);
      }
      for (let attempt = 0; attempt < REFRESH_LEASE_MS / 50 + 2; attempt++) {
        await this.sleep(50);
        const successor = this.dependencies.repository.getCredential(
          userId,
          CODESPACE_PROVIDER_GITHUB,
        );
        if (
          !successor ||
          (successor.connection.status !== "connected" &&
            !(allowInstallationRequired && successor.connection.status === "installation_required"))
        )
          break;
        if (successor.envelope.generation > current.envelope.generation) {
          return vault.decrypt(userId, CODESPACE_PROVIDER_GITHUB, connectionId, successor.envelope)
            .accessToken;
        }
        if (await this.failExpiredRefreshLease(userId, connectionId, current.envelope.generation)) {
          break;
        }
      }
      throw this.refreshFailure(userId, connectionId);
    }

    let refreshed: GitHubCodespaceTokenResponse | null = null;
    let successorRevocationId: string | null = null;
    let successorDispositionProven = false;
    let refreshSubmitted = false;
    try {
      if (credential.refreshTokenExpiresAt <= now) throw new Error("Refresh token expired");
      if (
        !this.dependencies.repository.markRefreshSubmitted({
          userId,
          connectionId,
          leaseId,
          expectedGeneration: current.envelope.generation,
          now: this.now(),
        })
      ) {
        throw new Error("Refresh lease changed before provider submission");
      }
      refreshSubmitted = true;
      refreshed = await this.dependencies.client(config).refreshToken(credential.refreshToken);
      validateTokenPayload(refreshed, this.now());
      successorRevocationId = this.retainCredentialForRevocation(userId, config, refreshed);
      successorDispositionProven = true;
      this.dependencies.repository.clearRefreshRecoveryMarker(userId, connectionId, this.now());
      const envelope = vault.encrypt(
        userId,
        CODESPACE_PROVIDER_GITHUB,
        connectionId,
        current.envelope.generation + 1,
        refreshed,
      );
      const completed = this.dependencies.repository.completeRefresh({
        userId,
        connectionId,
        leaseId,
        expectedGeneration: current.envelope.generation,
        envelope,
        now: this.now(),
      });
      if (!completed) throw new Error("Refresh generation changed");
      this.dependencies.repository.deletePendingRevocation(
        userId,
        CODESPACE_PROVIDER_GITHUB,
        successorRevocationId,
      );
      successorDispositionProven = true;
      return refreshed.accessToken;
    } catch {
      if (refreshed && !successorRevocationId) {
        try {
          await this.dependencies.client(config).revokeToken(refreshed.accessToken);
          successorDispositionProven = true;
          this.dependencies.repository.clearRefreshRecoveryMarker(userId, connectionId, this.now());
        } catch {
          try {
            await this.dependencies.client(config).revokeGrant(refreshed.accessToken);
            successorDispositionProven = true;
            this.dependencies.repository.clearRefreshRecoveryMarker(
              userId,
              connectionId,
              this.now(),
            );
          } catch {
            // The durable pre-submission marker forces explicit full-grant recovery.
          }
        }
      }
      const grantRecoveryRequired = refreshSubmitted && !successorDispositionProven;
      this.dependencies.repository.markRefreshFailed({
        userId,
        connectionId,
        leaseId,
        now: this.now(),
        errorCode: grantRecoveryRequired ? "AUTH_GRANT_REVOCATION_REQUIRED" : "AUTH_REFRESH_FAILED",
      });
      await this.dependencies.audit?.({
        action: "refresh_failed",
        userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        connectionId,
        outcome: grantRecoveryRequired
          ? "external_grant_revocation_required"
          : "reauthorization_required",
      });
      throw new CodespaceConnectionError(
        grantRecoveryRequired ? "AUTH_GRANT_REVOCATION_REQUIRED" : "AUTH_REFRESH_FAILED",
        grantRecoveryRequired
          ? "Revoke the GitHub App grant externally, then confirm recovery in Moira settings"
          : "Reconnect GitHub in Moira settings",
      );
    }
  }

  async disconnect(userId: string): Promise<CodespaceConnectionView> {
    const config = requireAvailableConfig(this.dependencies.config());
    const current = this.dependencies.repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    if (
      current?.lastErrorCode === "AUTH_GRANT_REVOCATION_REQUIRED" &&
      !this.dependencies.repository.isRefreshSubmissionInFlight(
        userId,
        CODESPACE_PROVIDER_GITHUB,
        this.now(),
      )
    ) {
      return this.getStatus(userId);
    }
    await this.dependencies.beforeDisconnect?.(userId);
    const stored = this.dependencies.repository.beginDisconnect(
      userId,
      CODESPACE_PROVIDER_GITHUB,
      this.now(),
    );
    if (!stored) {
      try {
        await this.drainPendingRevocations(userId, config);
      } catch {
        return this.getStatus(userId);
      }
      return this.getStatus(userId);
    }
    try {
      await this.drainPendingRevocations(userId, config);
    } catch {
      return this.getStatus(userId);
    }
    const vault = new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion);
    let credential: CodespaceCredentialPayload;
    try {
      credential = vault.decrypt(
        userId,
        CODESPACE_PROVIDER_GITHUB,
        stored.connection.id,
        stored.envelope,
      );
    } catch {
      this.dependencies.repository.markCredentialFailed(
        userId,
        stored.connection.id,
        this.now(),
        "CREDENTIAL_UNREADABLE",
      );
      await this.dependencies.audit?.({
        action: "disconnect",
        userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        connectionId: stored.connection.id,
        outcome: "revocation_pending",
      });
      return this.getStatus(userId);
    }
    try {
      await this.dependencies.client(config).revokeGrant(credential.accessToken);
      this.dependencies.repository.completeDisconnect(userId, stored.connection.id, this.now());
      await this.dependencies.audit?.({
        action: "disconnect",
        userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        connectionId: stored.connection.id,
        outcome: "revoked",
      });
    } catch {
      await this.dependencies.audit?.({
        action: "disconnect",
        userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        connectionId: stored.connection.id,
        outcome: "revocation_pending",
      });
    }
    return this.getStatus(userId);
  }

  async confirmExternalRevocation(
    userId: string,
    confirmed: boolean,
  ): Promise<CodespaceConnectionView> {
    if (!confirmed) {
      throw new CodespaceConnectionError(
        "CREDENTIAL_UNREADABLE",
        "External GitHub revocation confirmation is required",
      );
    }
    const snapshot = this.dependencies.repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    const config = this.dependencies.config();
    const pending = this.dependencies.repository.getPendingRevocations(
      userId,
      CODESPACE_PROVIDER_GITHUB,
    );
    const grantRecoveryRequired =
      snapshot?.lastErrorCode === "AUTH_GRANT_REVOCATION_REQUIRED" &&
      !this.dependencies.repository.isRefreshSubmissionInFlight(
        userId,
        CODESPACE_PROVIDER_GITHUB,
        this.now(),
      );
    let unreadable = snapshot?.lastErrorCode === "CREDENTIAL_UNREADABLE";
    if (config.state === "available") {
      unreadable = this.hasUnreadableCredential(userId, config);
      if (!unreadable && snapshot?.lastErrorCode === "CREDENTIAL_UNREADABLE") {
        this.dependencies.repository.clearUnreadableCredentialFailure(
          userId,
          snapshot.id,
          this.now(),
        );
      }
    }
    if ((!snapshot && pending.length === 0) || (!unreadable && !grantRecoveryRequired)) {
      throw new CodespaceConnectionError(
        "AUTHORIZATION_FAILED",
        "The GitHub connection does not require external revocation recovery",
      );
    }
    const completed = this.dependencies.repository.abandonAfterExternalRevocation({
      userId,
      provider: CODESPACE_PROVIDER_GITHUB,
      connectionId: snapshot?.id,
      now: this.now(),
    });
    if (!completed) {
      throw new CodespaceConnectionError(
        "CREDENTIAL_UNREADABLE",
        "External GitHub revocation recovery could not be completed",
      );
    }
    await this.dependencies.audit?.({
      action: "disconnect",
      userId,
      provider: CODESPACE_PROVIDER_GITHUB,
      connectionId: snapshot?.id,
      outcome: "external_revocation_confirmed",
    });
    return this.getStatus(userId);
  }
}
