import {
  AuditAction,
  AuditRepository,
  WORKSPACE_PROVIDER_GITHUB,
  WorkspaceConnectionRepository,
  WorkspaceConnectionService,
  WorkspaceProviderRegistry,
  WorkspaceOperationRepository,
  WorkspaceOperationService,
  WorkspaceFileService,
  WorkspaceTransferRepository,
  WorkspaceTransferService,
  WorkspaceResourceRepository,
  WorkspaceResourceService,
  getDatabase,
  getSqliteInstance,
  getWorkspaceGitHubConfig,
  getWorkspaceResourcePolicy,
  getDbPath,
  logAuditEventDirect,
  createLogger,
  type WorkspaceConnectionAuditEvent,
  type WorkspaceResourceAuditEvent,
  type WorkspaceOperationAuditEvent,
} from "@mcp-moira/shared";
import { dirname, join } from "node:path";

const workspaceLogger = createLogger({ component: "WorkspaceTransfer" });
import { GitHubCodespacesConnector } from "./github-codespaces-connector.js";
import { OpenAINativeReferenceFetcher } from "./workspace-native-reference-fetcher.js";
import { HttpGitHubWorkspaceClient } from "./github-workspace-client.js";

interface WorkspaceServices {
  connection: WorkspaceConnectionService;
  resource: WorkspaceResourceService | null;
  operation: WorkspaceOperationService | null;
  file: WorkspaceFileService | null;
  transfer: WorkspaceTransferService | null;
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
    case "start":
      return AuditAction.WORKSPACE_RESOURCE_START;
    case "stop":
      return AuditAction.WORKSPACE_RESOURCE_STOP;
    case "delete":
      return AuditAction.WORKSPACE_RESOURCE_DELETE;
  }
}

function operationAuditAction(event: WorkspaceOperationAuditEvent): AuditAction {
  switch (event.action) {
    case "reserve":
      return AuditAction.WORKSPACE_OPERATION_RESERVE;
    case "reconcile":
      return AuditAction.WORKSPACE_OPERATION_RECONCILE;
    case "terminal":
      return AuditAction.WORKSPACE_OPERATION_TERMINAL;
  }
}

function initializeWorkspaceServices(): WorkspaceServices {
  if (services) return services;
  const auditRepository = new AuditRepository(getDatabase());
  const config = getWorkspaceGitHubConfig();
  let resource: WorkspaceResourceService | null = null;
  let operation: WorkspaceOperationService | null = null;
  let file: WorkspaceFileService | null = null;
  let transfer: WorkspaceTransferService | null = null;
  const connection = new WorkspaceConnectionService({
    repository: new WorkspaceConnectionRepository(getSqliteInstance()),
    config: getWorkspaceGitHubConfig,
    client: (availableConfig) => new HttpGitHubWorkspaceClient(availableConfig),
    beforeDisconnect: async (userId) => {
      await resource?.cleanupBeforeDisconnect(userId);
    },
    afterConnect: async (userId) => {
      await resource?.rebindAfterAuthorization(userId);
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
        persistent: true,
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
    transfer = new WorkspaceTransferService({
      repository: new WorkspaceTransferRepository(getSqliteInstance()),
      policy: getWorkspaceResourcePolicy,
      root: join(dirname(getDbPath()), "workspace-transfers"),
      onCleanupError: (error) => workspaceLogger.error("Workspace transfer cleanup failed", error),
    });
    transfer.start();
    const nativeFetcher = new OpenAINativeReferenceFetcher();
    operation = new WorkspaceOperationService({
      repository: new WorkspaceOperationRepository(getSqliteInstance()),
      credentials: {
        getCredential: async (userId, providerId) => {
          if (providerId !== WORKSPACE_PROVIDER_GITHUB) {
            throw new Error("Workspace credential provider does not match the service binding");
          }
          return connection.getAccessToken(userId);
        },
      },
      transport: connector,
      policy: getWorkspaceResourcePolicy,
      transfers: transfer,
      nativeFetcher,
      audit: async (event) => {
        await logAuditEventDirect(auditRepository, {
          userId: event.userId,
          action: operationAuditAction(event),
          resource: "workspace_operation",
          resourceId: event.operationId,
          metadata: {
            workspaceId: event.workspaceId,
            provider: event.provider,
            state: event.state,
            kind: event.kind,
            inputBytes: event.inputBytes,
            outputBytes: event.outputBytes,
            exitCode: event.exitCode,
          },
        });
      },
    });
    file = new WorkspaceFileService({
      repository: new WorkspaceOperationRepository(getSqliteInstance()),
      credentials: {
        getCredential: async (userId, providerId) => {
          if (providerId !== WORKSPACE_PROVIDER_GITHUB) {
            throw new Error("Workspace credential provider does not match the service binding");
          }
          return connection.getAccessToken(userId);
        },
      },
      transport: connector,
      policy: getWorkspaceResourcePolicy,
      transfers: transfer,
      nativeFetcher,
      audit: async (event) => {
        await logAuditEventDirect(auditRepository, {
          userId: event.userId,
          action: operationAuditAction(event),
          resource: "workspace_operation",
          resourceId: event.operationId,
          metadata: {
            workspaceId: event.workspaceId,
            provider: event.provider,
            state: event.state,
            kind: event.kind,
            inputBytes: event.inputBytes,
            outputBytes: event.outputBytes,
            exitCode: event.exitCode,
          },
        });
      },
    });
  }

  services = { connection, resource, operation, file, transfer };
  return services;
}

export function getWorkspaceConnectionService(): WorkspaceConnectionService {
  return initializeWorkspaceServices().connection;
}

export function getWorkspaceResourceService(): WorkspaceResourceService | null {
  return initializeWorkspaceServices().resource;
}

export function getWorkspaceOperationService(): WorkspaceOperationService | null {
  return initializeWorkspaceServices().operation;
}

export function getWorkspaceFileService(): WorkspaceFileService | null {
  return initializeWorkspaceServices().file;
}

export function getWorkspaceTransferService(): WorkspaceTransferService | null {
  return initializeWorkspaceServices().transfer;
}
