import {
  CodespaceConnectionRepository,
  LocalResourceRepository,
  GitHubResourceRepository,
  WorkspaceAuthRepository,
  CODESPACE_PROVIDER_GITHUB,
  CODESPACE_PROVIDER_LOCAL,
  ScopedCredentialError,
  LocalDeviceError,
  CodespaceResourceError,
  getSqliteInstance,
  getCodespaceGitHubConfig,
  type ScopedCredentialAcquire,
  type LocalDeviceAuth,
  type LocalGitAuthorization,
} from "@mcp-moira/shared";
import {
  getCodespaceConnectionService,
  getLocalDeviceService,
  getCodespaceResourceService,
} from "./codespace-services.js";
import {
  authorizeWorkspaceAgentCredential,
  authorizeWorkspacePublication,
} from "./workspace-services.js";
import { HttpGitHubCodespaceClient } from "./github-codespace-client.js";
import {
  ScopedCredentialService,
  type ScopedCredentialAuthority,
} from "./scoped-credential-service.js";

export function createScopedCredentialService(): ScopedCredentialService {
  const sqlite = getSqliteInstance(),
    repository = new CodespaceConnectionRepository(sqlite);
  const authenticate = (bearer: string) => {
    try {
      return new WorkspaceAuthRepository(sqlite).authenticate(bearer).userId;
    } catch {
      try {
        return getLocalDeviceService().authenticateDevice(bearer).userId;
      } catch (error) {
        if (error instanceof LocalDeviceError && error.code === "LOCAL_UNAUTHORIZED")
          throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
        throw error;
      }
    }
  };
  function provisioningAuthority(
    auth: LocalDeviceAuth,
    input: ScopedCredentialAcquire,
  ): ScopedCredentialAuthority {
    const service = getCodespaceResourceService(),
      resource = service?.authority(auth.userId, input.resourceId);
    if (
      !resource ||
      resource.deviceId !== auth.deviceId ||
      resource.deviceGeneration !== auth.deviceGeneration ||
      resource.deviceConnectionId !== auth.connectionId ||
      resource.generation !== input.resourceGeneration
    )
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
    const connection = repository.getConnection(auth.userId, CODESPACE_PROVIDER_GITHUB),
      grant = connection?.repositories.find(
        (entry) =>
          entry.externalRepositoryId === resource.repositoryId &&
          entry.fullName.toLowerCase() === resource.repositoryFullName.toLowerCase(),
      );
    if (!grant) throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
    return {
      userId: auth.userId,
      repositoryFullName: grant.fullName,
      private: grant.private,
      useUntil: null,
      identity: JSON.stringify({
        deviceId: auth.deviceId,
        deviceGeneration: auth.deviceGeneration,
        connectionId: auth.connectionId,
        resourceId: resource.id,
        resourceGeneration: resource.generation,
        authorizationGeneration: resource.authorizationGeneration,
      }),
    };
  }
  function localAuthority(witness: LocalGitAuthorization): ScopedCredentialAuthority {
    const { auth, repository } = witness;
    return {
      userId: auth.userId,
      repositoryFullName: repository.fullName,
      private: repository.private,
      useUntil: witness.useUntil,
      identity: JSON.stringify({
        deviceId: auth.deviceId,
        deviceGeneration: auth.deviceGeneration,
        connectionId: auth.connectionId,
        resourceId: witness.resourceId,
        routeGeneration: witness.resourceGeneration,
        ownerResourceGeneration: witness.ownerResourceGeneration,
        ownerAppliedRevision: witness.appliedRevision,
        grant: repository,
      }),
    };
  }
  return new ScopedCredentialService({
    repository,
    connection: getCodespaceConnectionService(),
    config: getCodespaceGitHubConfig,
    client: (config) => new HttpGitHubCodespaceClient(config),
    authenticate,
    async isAuthorityCurrent(authority, input) {
      try {
        if (input.action === "codespaces_provision") {
          const identity = JSON.parse(authority.identity) as { deviceId: string },
            device = getLocalDeviceService().getDeviceIdentity(authority.userId, identity.deviceId);
          return provisioningAuthority(device, input).identity === authority.identity;
        }
        const github = new GitHubResourceRepository(sqlite).getOwned(
          authority.userId,
          input.resourceId,
        );
        const local = github
          ? null
          : new LocalResourceRepository(sqlite).getOwned(authority.userId, input.resourceId);
        const resource = github
          ? { ...github, provider: CODESPACE_PROVIDER_GITHUB }
          : local && local.retiredAt === null
            ? { ...local, provider: CODESPACE_PROVIDER_LOCAL }
            : null;
        if (!resource) return false;
        if (resource.provider === CODESPACE_PROVIDER_LOCAL) {
          const devices = getLocalDeviceService(),
            current = await devices.authorizeOwnedGitHubOperation(
              authority.userId,
              input.resourceId,
              input.action === "pull_request_create"
                ? "pull_request"
                : input.action === "push"
                  ? "push"
                  : "fetch",
            );
          const live = localAuthority(current);
          return (
            current.resourceGeneration === input.resourceGeneration &&
            live.identity === authority.identity &&
            live.useUntil === authority.useUntil
          );
        }
        if (
          resource.provider !== CODESPACE_PROVIDER_GITHUB ||
          (await authorizeWorkspacePublication(input.resourceId)) !== authority.userId
        )
          return false;
        const record = new WorkspaceAuthRepository(sqlite).getOwned(
          authority.userId,
          input.resourceId,
        );
        return Boolean(
          record &&
          record.resourceGeneration === input.resourceGeneration &&
          JSON.stringify({
            resourceId: record.resourceId,
            resourceGeneration: record.resourceGeneration,
            authorizationGeneration: record.authorizationGeneration,
            environmentIdentity: record.environmentIdentity,
          }) === authority.identity,
        );
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          ["LOCAL_UNAVAILABLE", "CODESPACE_PROVIDER_UNAVAILABLE"].includes(String(error.code))
        )
          throw new ScopedCredentialError("SCOPED_CREDENTIAL_UNAVAILABLE", 503);
        return false;
      }
    },
    async authorize(bearer: string, input: ScopedCredentialAcquire) {
      try {
        if (input.action === "codespaces_provision")
          return provisioningAuthority(getLocalDeviceService().authenticateDevice(bearer), input);
        const userId = authenticate(bearer),
          github = new GitHubResourceRepository(sqlite).getOwned(userId, input.resourceId),
          local = github
            ? null
            : new LocalResourceRepository(sqlite).getOwned(userId, input.resourceId),
          resource = github
            ? { ...github, provider: CODESPACE_PROVIDER_GITHUB }
            : local && local.retiredAt === null
              ? { ...local, provider: CODESPACE_PROVIDER_LOCAL }
              : null;
        if (!resource) throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
        if (resource.provider === CODESPACE_PROVIDER_LOCAL) {
          const devices = getLocalDeviceService(),
            auth = devices.authenticateDevice(bearer);
          const witness = await devices.authorizeGitHubOperation(
            auth,
            input.resourceId,
            input.resourceGeneration,
            input.action === "pull_request_create"
              ? "pull_request"
              : input.action === "push"
                ? "push"
                : "fetch",
          );
          return localAuthority(witness);
        }
        if (resource.provider !== CODESPACE_PROVIDER_GITHUB)
          throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
        const binding = await authorizeWorkspaceAgentCredential(
          bearer,
          input.resourceId,
          input.resourceGeneration,
        );
        const connection = repository.getConnection(userId, CODESPACE_PROVIDER_GITHUB),
          grant = connection?.repositories.find(
            (entry) =>
              entry.externalRepositoryId === resource.repositoryId &&
              entry.fullName.toLowerCase() === resource.repositoryFullName.toLowerCase(),
          );
        if (!grant) throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
        return {
          userId,
          repositoryFullName: grant.fullName,
          private: grant.private,
          useUntil: binding.expiresAt,
          identity: JSON.stringify({
            resourceId: binding.resourceId,
            resourceGeneration: binding.resourceGeneration,
            authorizationGeneration: binding.authorizationGeneration,
            environmentIdentity: binding.environmentIdentity,
          }),
        };
      } catch (error) {
        if (
          error instanceof CodespaceResourceError &&
          [
            "CODESPACE_AUTHORIZATION_REQUIRED",
            "CODESPACE_GENERATION_CONFLICT",
            "CODESPACE_PROVIDER_DISABLED",
            "CODESPACE_NOT_FOUND",
            "CODESPACE_PROVIDER_UNAVAILABLE",
          ].includes(error.code)
        ) {
          throw new ScopedCredentialError(
            error.code === "CODESPACE_PROVIDER_UNAVAILABLE"
              ? "SCOPED_CREDENTIAL_UNAVAILABLE"
              : "SCOPED_CREDENTIAL_AUTHORITY_REFUSED",
            error.code === "CODESPACE_PROVIDER_UNAVAILABLE" ? 503 : 403,
          );
        }
        if (error instanceof LocalDeviceError) {
          if (["LOCAL_UNAUTHORIZED", "LOCAL_CONFLICT", "LOCAL_EXPIRED"].includes(error.code))
            throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 403);
          if (error.code === "LOCAL_UNAVAILABLE")
            throw new ScopedCredentialError("SCOPED_CREDENTIAL_UNAVAILABLE", 503);
        }
        throw error;
      }
    },
  });
}

let service: ScopedCredentialService | undefined;
export function getScopedCredentialService(): ScopedCredentialService {
  return (service ??= createScopedCredentialService());
}
