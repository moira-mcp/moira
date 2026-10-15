import {
  AuditAction,
  AuditRepository,
  CODESPACE_PROVIDER_GITHUB,
  CODESPACE_PROVIDER_LOCAL,
  CodespaceConnectionRepository,
  CodespaceConnectionService,
  LocalResourceRepository,
  GitHubResourceRepository,
  CodespaceResourceError,
  CodespaceObservabilityService,
  recordCodespaceConnectionEvent,
  getDatabase,
  getSqliteInstance,
  getCodespaceGitHubConfig,
  getCodespaceResourcePolicy,
  getBaseUrl,
  logAuditEventDirect,
  type CodespaceConnectionAuditEvent,
  type CodespaceGuidanceSituation,
  type CodespaceProviderBillingView,
  type CodespaceProviderGuidance,
} from "@mcp-moira/shared";
import { createLocalCodespaceServices } from "./local-codespace-services.js";
import { getScopedCredentialService } from "./scoped-credential-factory.js";
import type { LocalCodespaceResourceService } from "./local-codespace-resource-service.js";
import { getWorkspaceClient, getControllerClient } from "./workspace-client.js";
import type { WorkspaceClient } from "./workspace-router.js";
import {
  GitHubCodespaceClientError,
  HttpGitHubCodespaceClient,
  githubCodespaceGuidance,
} from "./github-codespace-client.js";
import { GitHubResourceService } from "./github-resource-service.js";

interface CodespaceServices {
  connection: CodespaceConnectionService;
  resource: GitHubResourceService | null;
  workspace: WorkspaceClient;
  observability: CodespaceObservabilityService;
  billing: (userId: string, options?: { force?: boolean }) => Promise<CodespaceProviderBillingView>;
  local: ReturnType<typeof createLocalCodespaceServices>;
}
export interface CodespaceProviderServices {
  resource: GitHubResourceService | LocalCodespaceResourceService | null;
  workspace: WorkspaceClient;
  observability:
    | Pick<CodespaceObservabilityService, "readiness">
    | ReturnType<typeof createLocalCodespaceServices>["observability"];
  provider: string;
  connection: Pick<CodespaceConnectionService, "getStatus" | "refreshGrants">;
  guidance: (situation: CodespaceGuidanceSituation) => {
    provider: string;
    situation: CodespaceGuidanceSituation;
    instruction: string | null;
    links: CodespaceProviderGuidance["links"];
  };
  billing?: CodespaceServices["billing"];
}

/** Read actual GitHub billing with the current account; no operational readiness cache. */
export function createCodespaceBillingReader(dependencies: {
  connection: Pick<CodespaceConnectionService, "getStatus" | "getAccessToken">;
  authorization: (
    userId: string,
  ) => { accountId: string; credentialGeneration: number; status: string } | null;
  client: Pick<HttpGitHubCodespaceClient, "getMonthlyBilling"> | null;
}) {
  return async (
    userId: string,
    _options?: { force?: boolean },
  ): Promise<CodespaceProviderBillingView> => {
    const status = dependencies.connection.getStatus(userId),
      authorization = dependencies.authorization(userId);
    if (
      status.state !== "connected" ||
      !status.account ||
      !dependencies.client ||
      authorization?.status !== "connected" ||
      authorization.accountId !== status.account.id
    )
      return "unavailable";
    try {
      const result = await dependencies.client.getMonthlyBilling(
        await dependencies.connection.getAccessToken(userId),
        status.account,
      );
      const current = dependencies.authorization(userId);
      return current?.status === "connected" &&
        current.accountId === authorization.accountId &&
        current.credentialGeneration === authorization.credentialGeneration
        ? result
        : "unavailable";
    } catch {
      return "unavailable";
    }
  };
}
let services: CodespaceServices | null = null;
function connectionAuditAction(event: CodespaceConnectionAuditEvent): AuditAction {
  switch (event.action) {
    case "start":
      return AuditAction.CODESPACE_CONNECTION_START;
    case "complete":
      return AuditAction.CODESPACE_CONNECTION_COMPLETE;
    case "refresh_failed":
      return AuditAction.CODESPACE_CONNECTION_REFRESH_FAILED;
    case "disconnect":
      return AuditAction.CODESPACE_CONNECTION_DISCONNECT;
  }
}
function initializeCodespaceServices(): CodespaceServices {
  if (services) return services;
  const sqlite = getSqliteInstance(),
    auditRepository = new AuditRepository(getDatabase()),
    identities = new GitHubResourceRepository(sqlite),
    connectionRepository = new CodespaceConnectionRepository(sqlite),
    config = getCodespaceGitHubConfig();
  const connection = new CodespaceConnectionService({
    repository: connectionRepository,
    config: getCodespaceGitHubConfig,
    client: (availableConfig) => new HttpGitHubCodespaceClient(availableConfig),
    isProviderFailure: (error) => error instanceof GitHubCodespaceClientError,
    beforeCredentialRetirement: (userId) => getScopedCredentialService().disposeUser(userId),
    audit: async (event) => {
      recordCodespaceConnectionEvent(event);
      await logAuditEventDirect(auditRepository, {
        userId: event.userId,
        action: connectionAuditAction(event),
        resource: "codespace_connection",
        resourceId: event.connectionId,
        metadata: { provider: event.provider, outcome: event.outcome },
      });
    },
  });
  const local = createLocalCodespaceServices({
    github: connection,
    retireDeviceCredentials: (userId, deviceId, retirement) =>
      retirement.kind === "resource"
        ? getScopedCredentialService().disposeResource(
            userId,
            retirement.resourceId,
            retirement.throughGeneration,
          )
        : getScopedCredentialService().disposeDevice(
            userId,
            deviceId,
            retirement.kind === "settings" ? retirement.throughRevision : undefined,
          ),
  });
  const client = config.state === "available" ? new HttpGitHubCodespaceClient(config) : null;
  const resource = client
    ? new GitHubResourceService(
        identities,
        connection,
        client,
        local.devices,
        getControllerClient(),
        (userId, resourceId, throughGeneration) =>
          getScopedCredentialService().disposeResource(userId, resourceId, throughGeneration),
        getCodespaceResourcePolicy,
        getCodespaceGitHubConfig,
        getBaseUrl,
        async (binding) => {
          if (binding.kind !== "workspace") return false;
          // An explicit status read observes the owner through the normal route;
          // admission never consults a second availability registry.
          const observed = await getWorkspaceClient().json(binding.userId, binding.resourceId, {
            method: "GET",
            path: "/v1/health",
          });
          return observed.environmentIdentity === binding.environmentIdentity;
        },
      )
    : null;
  const billing = createCodespaceBillingReader({
    connection,
    client,
    authorization: (userId) => {
      const snapshot = connectionRepository.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
      return snapshot
        ? {
            accountId: snapshot.externalAccountId,
            credentialGeneration: snapshot.credentialGeneration,
            status: snapshot.status,
          }
        : null;
    },
  });
  const observability = new CodespaceObservabilityService({
    providerId: CODESPACE_PROVIDER_GITHUB,
    config: getCodespaceGitHubConfig,
    policy: getCodespaceResourcePolicy,
  });
  return (services = {
    connection,
    local,
    resource,
    billing,
    observability,
    workspace: getWorkspaceClient(),
  });
}
export function getCodespaceObservabilityService() {
  return initializeCodespaceServices().observability;
}
export function getCodespaceConnectionService() {
  return initializeCodespaceServices().connection;
}
export function getCodespaceResourceService() {
  return initializeCodespaceServices().resource;
}
export function getCodespaceProviderBilling(userId: string) {
  return initializeCodespaceServices().billing(userId);
}
export function getLocalDeviceService() {
  return initializeCodespaceServices().local.devices;
}
export function getCodespaceProviderServices(provider: string): CodespaceProviderServices {
  const current = initializeCodespaceServices();
  if (provider === CODESPACE_PROVIDER_LOCAL)
    return {
      ...current.local,
      provider,
      guidance: (situation) => current.local.resource.setupGuidance(situation),
    };
  if (provider !== CODESPACE_PROVIDER_GITHUB) throw new Error("Unknown codespace provider");
  return {
    connection: current.connection,
    resource: current.resource,
    workspace: current.workspace,
    observability: current.observability,
    provider,
    guidance: getCodespaceSetupGuidance,
    billing: current.billing,
  };
}
export function getCodespaceProviderBundles() {
  return [
    getCodespaceProviderServices(CODESPACE_PROVIDER_GITHUB),
    getCodespaceProviderServices(CODESPACE_PROVIDER_LOCAL),
  ];
}
export function selectCodespaceProviderServices(
  userId: string,
  input: { repositoryId?: string; codespaceId?: string },
) {
  if (input.codespaceId !== undefined) {
    if (new GitHubResourceRepository(getSqliteInstance()).getOwned(userId, input.codespaceId))
      return getCodespaceProviderServices(CODESPACE_PROVIDER_GITHUB);
    const local = new LocalResourceRepository(getSqliteInstance()).getOwned(
      userId,
      input.codespaceId,
    );
    if (!local)
      throw new CodespaceResourceError(
        "CODESPACE_NOT_FOUND",
        "Codespace is not owned by this caller",
      );
    return getCodespaceProviderServices(CODESPACE_PROVIDER_LOCAL);
  }
  return getCodespaceProviderServices(
    input.repositoryId?.startsWith("local:") ? CODESPACE_PROVIDER_LOCAL : CODESPACE_PROVIDER_GITHUB,
  );
}
export function getCodespaceSetupGuidance(situation: CodespaceGuidanceSituation) {
  const guidance = githubCodespaceGuidance(getCodespaceGitHubConfig());
  return {
    provider: CODESPACE_PROVIDER_GITHUB,
    situation,
    instruction: guidance.instructions[situation] ?? null,
    links: guidance.links,
  };
}
