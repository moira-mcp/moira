import {
  AuditAction,
  AuditRepository,
  WORKSPACE_PROVIDER_GITHUB,
  WorkspaceConnectionRepository,
  WorkspaceConnectionService,
  WorkspaceProviderRegistry,
  WorkspaceResourceRepository,
  WorkspaceResourceService,
  getDatabase,
  getSqliteInstance,
  getWorkspaceGitHubConfig,
  getWorkspaceResourcePolicy,
  logAuditEventDirect,
  type WorkspaceConnectionAuditEvent,
  type WorkspaceResourceAuditEvent,
} from "@mcp-moira/shared";
import { GitHubCodespacesConnector } from "./github-codespaces-connector.js";
import { HttpGitHubWorkspaceClient } from "./github-workspace-client.js";

interface WorkspaceServices {
  connection: WorkspaceConnectionService;
  resource: WorkspaceResourceService | null;
}

let services: WorkspaceServices | null = null;

function connectionAuditAction(event: WorkspaceConnectionAuditEvent): AuditAction {
  switch (event.action) {
    case "start":
      return AuditAction.WORKSPACE_CONNECTION_START;
    case "complete":
      return AuditAction.WORKSPACE_CONNECTION_COMPLETE;
    case "refresh_failed":
      return AuditAction.WORKSPACE_CONNECTION_REFRESH_FAILED;
    case "disconnect":
      return AuditAction.WORKSPACE_CONNECTION_DISCONNECT;
  }
}

function resourceAuditAction(event: WorkspaceResourceAuditEvent): AuditAction {
  switch (event.action) {
    case "create":
      return AuditAction.WORKSPACE_RESOURCE_CREATE;
    case "create_pending":
      return AuditAction.WORKSPACE_RESOURCE_CREATE_PENDING;
    case "create_rejected":
      return AuditAction.WORKSPACE_RESOURCE_CREATE_REJECTED;
    case "cleanup":
      return AuditAction.WORKSPACE_RESOURCE_CLEANUP;
  }
}

function initializeWorkspaceServices(): WorkspaceServices {
  if (services) return services;
  const auditRepository = new AuditRepository(getDatabase());
  const config = getWorkspaceGitHubConfig();
  let resource: WorkspaceResourceService | null = null;
  const connection = new WorkspaceConnectionService({
    repository: new WorkspaceConnectionRepository(getSqliteInstance()),
    config: getWorkspaceGitHubConfig,
    client: (availableConfig) => new HttpGitHubWorkspaceClient(availableConfig),
    beforeDisconnect: async (userId) => {
      await resource?.cleanupBeforeDisconnect(userId);
    },
    audit: async (event) => {
      await logAuditEventDirect(auditRepository, {
        userId: event.userId,
        action: connectionAuditAction(event),
        resource: "workspace_connection",
        resourceId: event.connectionId,
        metadata: { provider: event.provider, outcome: event.outcome },
      });
    },
  });

  if (config.state === "available") {
    const connector = new GitHubCodespacesConnector();
    const provider = new HttpGitHubWorkspaceClient(
      config,
      fetch,
      Date.now,
      () => connector.health(),
      (credential, resourceName) => connector.probeSshConfiguration(credential, resourceName),
    );
    const registry = new WorkspaceProviderRegistry();
    registry.register(provider);
    const resourceRepository = new WorkspaceResourceRepository(getSqliteInstance());
    resource = new WorkspaceResourceService({
      repository: resourceRepository,
      repositories: resourceRepository,
      registry,
      providerId: WORKSPACE_PROVIDER_GITHUB,
      requiredCapabilities: {
        disposable: true,
        exactLifecycle: true,
        personalBillingOnly: true,
      },
      credentials: {
        getCredential: async (userId, providerId) => {
          if (providerId !== WORKSPACE_PROVIDER_GITHUB) {
            throw new Error("Workspace credential provider does not match the service binding");
          }
          return connection.getAccessToken(userId);
        },
      },
      policy: getWorkspaceResourcePolicy,
      audit: async (event) => {
        await logAuditEventDirect(auditRepository, {
          userId: event.userId,
          action: resourceAuditAction(event),
          resource: "workspace_resource",
          resourceId: event.resourceId,
          metadata: {
            provider: event.provider,
            outcome: event.outcome,
            state: event.state,
            machine: event.machine,
          },
        });
      },
    });
  }

  services = { connection, resource };
  return services;
}

export function getWorkspaceConnectionService(): WorkspaceConnectionService {
  return initializeWorkspaceServices().connection;
}

export function getWorkspaceResourceService(): WorkspaceResourceService | null {
  return initializeWorkspaceServices().resource;
}
