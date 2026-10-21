import { randomUUID } from "node:crypto";
import {
  CODESPACE_PROVIDER_GITHUB,
  CodespaceCredentialVault,
  ScopedCredentialError,
  ScopedCredentialIssuanceRefused,
  SCOPED_CREDENTIAL_PERMISSIONS,
  scopedCredentialViewSchema,
  type CodespaceConnectionRepository,
  type CodespaceConnectionService,
  type CodespaceGitHubConfigStatus,
  type GitHubScopedCredentialClient,
  type ScopedCredentialAcquire,
  type ScopedCredentialRelease,
  type ScopedCredentialView,
  type ScopedCredentialCollection,
  type StoredScopedCredential,
} from "@mcp-moira/shared";

export interface ScopedCredentialAuthority {
  userId: string;
  repositoryFullName: string;
  private: boolean;
  /** Current owner/account/life witness, containing no bearer credentials. */
  identity: string;
  useUntil: number | null;
}
export interface ScopedCredentialServiceDependencies {
  repository: CodespaceConnectionRepository;
  connection: Pick<CodespaceConnectionService, "getScopedCredentialParent" | "refreshGrants">;
  config: () => CodespaceGitHubConfigStatus;
  client: (
    config: Extract<CodespaceGitHubConfigStatus, { state: "available" }>,
  ) => GitHubScopedCredentialClient;
  authorize: (bearer: string, input: ScopedCredentialAcquire) => Promise<ScopedCredentialAuthority>;
  authenticate: (bearer: string) => string;
  isAuthorityCurrent?: (
    authority: ScopedCredentialAuthority,
    input: ScopedCredentialAcquire,
  ) => Promise<boolean>;
  now?: () => number;
}
interface ScopeWitness {
  request: ScopedCredentialAcquire;
  authority: ScopedCredentialAuthority;
  connectionId: string;
  credentialGeneration: number;
  externalAccountId: string;
  externalLogin: string;
  installationId: string;
  repositoryId: string;
  parentExpiresAt: number;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Issuer security custody. This service never executes Git or a pull request. */
export class ScopedCredentialService {
  private readonly now: () => number;
  constructor(private readonly dependencies: ScopedCredentialServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
  }
  private configuration() {
    const config = this.dependencies.config();
    if (config.state !== "available")
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_UNAVAILABLE", 503);
    return {
      config,
      vault: new CodespaceCredentialVault(config.vaultKeyHex, config.vaultKeyVersion),
      client: this.dependencies.client(config),
    };
  }
  private async authority(bearer: string, input: ScopedCredentialAcquire, refresh: boolean) {
    const authority = await this.dependencies.authorize(bearer, input);
    if (authority.useUntil !== null && authority.useUntil <= this.now())
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
    if (
      refresh &&
      (await this.dependencies.connection.refreshGrants(authority.userId, { force: true })).stale
    )
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
    const parent = await this.dependencies.connection.getScopedCredentialParent(authority.userId, {
      refresh,
    });
    const current = await this.dependencies.authorize(bearer, input);
    if (!same(authority, current))
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
    const grant = parent.connection.repositories.find(
      (repo) =>
        repo.fullName.toLowerCase() === current.repositoryFullName.toLowerCase() &&
        repo.private === current.private,
    );
    if (
      !grant ||
      !parent.connection.installations.some(
        (installation) => installation.externalInstallationId === grant.externalInstallationId,
      )
    )
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
    const witness: ScopeWitness = {
      request: input,
      authority: current,
      connectionId: parent.connection.id,
      credentialGeneration: parent.connection.credentialGeneration,
      externalAccountId: parent.connection.externalAccountId,
      externalLogin: parent.connection.externalLogin,
      installationId: grant.externalInstallationId,
      repositoryId: grant.externalRepositoryId,
      parentExpiresAt: parent.expiresAt,
    };
    return { parent, witness };
  }
  private update(
    row: StoredScopedCredential,
    state: StoredScopedCredential["state"],
    token: string | null,
    expiresAt: number | null,
  ) {
    const { vault } = this.configuration();
    const envelope = vault.encryptScoped(
      row.userId,
      row.provider,
      row.id,
      row.envelope.generation,
      {
        token,
        expiresAt,
      },
    );
    if (
      !this.dependencies.repository.updateScopedCredential({
        id: row.id,
        userId: row.userId,
        provider: row.provider,
        expectedState: row.state,
        state,
        envelope,
        now: this.now(),
      })
    )
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_CONFLICT");
    return { ...row, state, envelope };
  }
  private metadataValid(
    metadata: unknown,
    witness: ScopeWitness,
    expiresAt: number | null,
  ): boolean {
    const body = object(metadata),
      app = object(body?.app),
      user = object(body?.user),
      installation = object(body?.installation),
      account = object(installation?.account),
      permissions = object(installation?.permissions);
    const { config } = this.configuration();
    return (
      expiresAt !== null &&
      expiresAt > this.now() &&
      app?.client_id === config.clientId &&
      String(user?.id) === witness.externalAccountId &&
      typeof user?.login === "string" &&
      user.login.toLowerCase() === witness.externalLogin.toLowerCase() &&
      typeof account?.login === "string" &&
      account.login.toLowerCase() ===
        witness.authority.repositoryFullName.split("/")[0]!.toLowerCase() &&
      installation?.repository_selection === "selected" &&
      permissions !== null &&
      Object.keys(permissions).length ===
        Object.keys(SCOPED_CREDENTIAL_PERMISSIONS[witness.request.action]).length &&
      Object.entries(SCOPED_CREDENTIAL_PERMISSIONS[witness.request.action]).every(
        ([key, value]) => permissions[key] === value,
      ) &&
      Array.isArray(body?.scopes) &&
      body.scopes.length === 0
    );
  }
  private async existing(
    bearer: string,
    input: ScopedCredentialAcquire,
    previous: StoredScopedCredential,
  ): Promise<ScopedCredentialView> {
    const userId = previous.userId;
    const witness = JSON.parse(previous.scopeMetadata) as ScopeWitness;
    if (!same(witness.request, input))
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_CONFLICT");
    if (previous.state !== "live")
      throw new ScopedCredentialError(
        previous.state === "issuing" || previous.state === "unconfirmed"
          ? "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED"
          : "SCOPED_CREDENTIAL_UNAVAILABLE",
      );
    const { vault } = this.configuration(),
      payload = vault.decryptScoped(
        userId,
        CODESPACE_PROVIDER_GITHUB,
        previous.id,
        previous.envelope,
      );
    try {
      const current = await this.authority(bearer, input, false);
      if (
        !same(current.witness, witness) ||
        !payload.token ||
        payload.expiresAt === null ||
        payload.expiresAt <= this.now() ||
        (witness.authority.useUntil !== null && witness.authority.useUntil <= this.now())
      )
        throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
    } catch {
      await this.dispose(previous);
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
    }
    return scopedCredentialViewSchema.parse({
      credentialId: previous.id,
      token: payload.token,
      expiresAt: payload.expiresAt,
      useUntil: Math.min(
        payload.expiresAt!,
        witness.parentExpiresAt,
        witness.authority.useUntil ?? payload.expiresAt!,
      ),
      repositoryFullName: witness.authority.repositoryFullName,
    });
  }
  async collect(
    bearer: string,
    input: ScopedCredentialAcquire,
  ): Promise<ScopedCredentialCollection> {
    const userId = this.dependencies.authenticate(bearer);
    await this.dependencies.authorize(bearer, input);
    const row = this.dependencies.repository.getScopedCredential(
      userId,
      CODESPACE_PROVIDER_GITHUB,
      { requestId: input.requestId },
    );
    if (!row) return { state: "absent" };
    const witness = JSON.parse(row.scopeMetadata) as ScopeWitness;
    if (!same(witness.request, input))
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_CONFLICT");
    if (row.state === "live")
      return { state: "live", credential: await this.existing(bearer, input, row) };
    if (row.state === "disposed" || row.state === "refused") return { state: row.state };
    return { state: "unconfirmed" };
  }
  async acquire(bearer: string, input: ScopedCredentialAcquire): Promise<ScopedCredentialView> {
    const userId = this.dependencies.authenticate(bearer);
    const previous = this.dependencies.repository.getScopedCredential(
      userId,
      CODESPACE_PROVIDER_GITHUB,
      { requestId: input.requestId },
    );
    if (previous) return this.existing(bearer, input, previous);
    const { parent, witness } = await this.authority(bearer, input, true);
    const numericId = Number(witness.repositoryId);
    if (
      !Number.isSafeInteger(numericId) ||
      numericId <= 0 ||
      String(numericId) !== witness.repositoryId
    )
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
    const { vault, client } = this.configuration(),
      id = randomUUID();
    if (
      !this.dependencies.repository.reserveScopedCredential({
        id,
        userId,
        provider: CODESPACE_PROVIDER_GITHUB,
        requestId: input.requestId,
        scopeMetadata: JSON.stringify(witness),
        envelope: vault.encryptScoped(
          userId,
          CODESPACE_PROVIDER_GITHUB,
          id,
          witness.credentialGeneration,
          { token: null, expiresAt: null },
        ),
        now: this.now(),
      })
    )
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_CONFLICT");
    let row = this.dependencies.repository.getScopedCredential(userId, CODESPACE_PROVIDER_GITHUB, {
      credentialId: id,
    })!;
    let candidate;
    try {
      candidate = await client.createScopedToken(parent.token, {
        repositoryId: numericId,
        target: witness.authority.repositoryFullName.split("/")[0]!,
        permissions: SCOPED_CREDENTIAL_PERMISSIONS[input.action],
      });
    } catch (error) {
      if (error instanceof ScopedCredentialIssuanceRefused) {
        try {
          this.update(row, "refused", null, null);
        } catch {
          // The provider's confirmed refusal remains known even if its receipt cannot advance.
        }
        throw new ScopedCredentialError("SCOPED_CREDENTIAL_ISSUANCE_REFUSED", 403);
      }
      try {
        this.update(row, "unconfirmed", null, null);
      } catch {
        // The durable issuing reservation already fences this submitted request.
      }
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED", 503);
    }
    // The exact known capability enters encrypted custody before any metadata checks.
    try {
      row = this.update(row, "dispose_pending", candidate.token, candidate.expiresAt);
    } catch {
      // A storage failure cannot turn a known provider capability into a discarded one.
      try {
        await client.revokeScopedToken(candidate.token);
      } catch {
        throw new ScopedCredentialError("SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED", 503);
      }
      // Keep the original nonce fenced even if recording confirmed disposal also fails.
      try {
        this.update(row, "disposed", null, null);
      } catch {
        /* The original issuing row remains fenced. */
      }
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_CUSTODY_REFUSED", 503);
    }
    const retained = row;
    try {
      if (!this.metadataValid(candidate.metadata, witness, candidate.expiresAt))
        throw new ScopedCredentialError("SCOPED_CREDENTIAL_SCOPE_REFUSED", 403);
      const current = await this.authority(bearer, input, false);
      if (!same(current.witness, witness))
        throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
      const result = scopedCredentialViewSchema.parse({
        credentialId: id,
        token: candidate.token,
        expiresAt: candidate.expiresAt,
        useUntil: Math.min(
          candidate.expiresAt!,
          witness.parentExpiresAt,
          witness.authority.useUntil ?? candidate.expiresAt!,
        ),
        repositoryFullName: witness.authority.repositoryFullName,
      });
      this.update(retained, "live", candidate.token, candidate.expiresAt);
      return result;
    } catch {
      await this.dispose(retained);
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_SCOPE_REFUSED", 403);
    }
  }
  private async dispose(row: StoredScopedCredential) {
    try {
      row =
        this.dependencies.repository.getScopedCredential(row.userId, row.provider, {
          credentialId: row.id,
        }) ?? row;
      if (row.state === "disposed") return;
      const { vault, client } = this.configuration(),
        payload = vault.decryptScoped(row.userId, row.provider, row.id, row.envelope);
      if (!payload.token)
        throw new ScopedCredentialError("SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED", 503);
      if (row.state !== "dispose_pending")
        row = this.update(row, "dispose_pending", payload.token, payload.expiresAt);
      await client.revokeScopedToken(payload.token);
      this.update(row, "disposed", null, null);
    } catch (error) {
      if (
        error instanceof ScopedCredentialError &&
        error.code === "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED"
      )
        throw error;
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_DISPOSAL_PENDING", 503);
    }
  }
  async release(
    bearer: string,
    credentialId: string,
    input: ScopedCredentialRelease,
  ): Promise<void> {
    const userId = this.dependencies.authenticate(bearer),
      row = this.dependencies.repository.getScopedCredential(userId, CODESPACE_PROVIDER_GITHUB, {
        credentialId,
      });
    if (!row) throw new ScopedCredentialError("SCOPED_CREDENTIAL_NOT_FOUND", 404);
    const witness = JSON.parse(row.scopeMetadata) as ScopeWitness;
    if (
      witness.request.resourceId !== input.resourceId ||
      witness.request.resourceGeneration !== input.resourceGeneration
    )
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_CONFLICT");
    await this.dispose(row);
  }
  /** Called on authority retirement/recovery; never turns unknown issuance into a known child. */
  private async disposeMatching(
    userId: string,
    matches: (witness: ScopeWitness) => boolean,
    retire?: (witness: ScopeWitness) => Promise<boolean>,
  ): Promise<void> {
    let pending = false;
    for (const row of this.dependencies.repository.getScopedCredentials(
      userId,
      CODESPACE_PROVIDER_GITHUB,
    )) {
      try {
        const witness = JSON.parse(row.scopeMetadata) as ScopeWitness;
        if (
          matches(witness) &&
          this.configuration().vault.decryptScoped(userId, row.provider, row.id, row.envelope)
            .token &&
          (!retire || (await retire(witness)))
        )
          await this.dispose(row);
      } catch {
        pending = true;
      }
    }
    if (pending) throw new ScopedCredentialError("SCOPED_CREDENTIAL_DISPOSAL_PENDING", 503);
  }
  async disposeUser(userId: string): Promise<void> {
    return this.disposeMatching(userId, () => true);
  }

  async disposeResource(
    userId: string,
    resourceId: string,
    throughGeneration?: number,
  ): Promise<void> {
    return this.disposeMatching(userId, (witness) => {
      let identity: Record<string, unknown> | null = null;
      if (throughGeneration !== undefined)
        try {
          identity = object(JSON.parse(witness.authority.identity));
        } catch {
          /* Unversioned authority cannot outlive a confirmed retirement. */
        }
      return (
        witness.request.resourceId === resourceId &&
        (throughGeneration === undefined ||
          (typeof identity?.ownerResourceGeneration === "number"
            ? identity.ownerResourceGeneration
            : witness.request.resourceGeneration) <= throughGeneration)
      );
    });
  }

  async disposeDevice(userId: string, deviceId: string): Promise<void> {
    return this.disposeMatching(userId, (witness) => {
      let identity: Record<string, unknown> | null = null;
      try {
        identity = object(JSON.parse(witness.authority.identity));
      } catch {
        /* Other provider witness. */
      }
      return identity?.deviceId === deviceId;
    });
  }

  /** A settings revision alone is not revocation; retire only authority no longer granted. */
  async revalidateDevice(userId: string, deviceId: string): Promise<void> {
    return this.disposeMatching(
      userId,
      (witness) => object(JSON.parse(witness.authority.identity))?.deviceId === deviceId,
      async (witness) =>
        !this.dependencies.isAuthorityCurrent ||
        !(await this.dependencies.isAuthorityCurrent(witness.authority, witness.request)),
    );
  }

  async recover(): Promise<{ disposed: number; pending: number }> {
    const summary = { disposed: 0, pending: 0 };
    for (const userId of this.dependencies.repository.getScopedCredentialUsers(
      CODESPACE_PROVIDER_GITHUB,
    )) {
      const connection = this.dependencies.repository.getConnection(
        userId,
        CODESPACE_PROVIDER_GITHUB,
      );
      for (const row of this.dependencies.repository.getScopedCredentials(
        userId,
        CODESPACE_PROVIDER_GITHUB,
      )) {
        try {
          const { vault } = this.configuration(),
            payload = vault.decryptScoped(userId, row.provider, row.id, row.envelope),
            witness = JSON.parse(row.scopeMetadata) as ScopeWitness;
          const grant = connection?.repositories.find(
            (repo) =>
              repo.externalRepositoryId === witness.repositoryId &&
              repo.externalInstallationId === witness.installationId &&
              repo.fullName.toLowerCase() === witness.authority.repositoryFullName.toLowerCase() &&
              repo.private === witness.authority.private,
          );
          const ownerRetired =
            payload.token && row.state === "live" && this.dependencies.isAuthorityCurrent
              ? !(await this.dependencies.isAuthorityCurrent(witness.authority, witness.request))
              : false;
          if (
            payload.token &&
            (row.state === "dispose_pending" ||
              !connection ||
              connection.status !== "connected" ||
              connection.id !== witness.connectionId ||
              connection.credentialGeneration !== witness.credentialGeneration ||
              !grant ||
              payload.expiresAt === null ||
              payload.expiresAt <= this.now() ||
              witness.parentExpiresAt <= this.now() ||
              ownerRetired ||
              (witness.authority.useUntil !== null && witness.authority.useUntil <= this.now()))
          ) {
            await this.dispose(row);
            summary.disposed++;
          }
        } catch {
          summary.pending++;
        }
      }
    }
    return summary;
  }
}
