import {
  AuditAction,
  AuditRepository,
  CODESPACE_PROVIDER_GITHUB,
  CodespaceConnectionRepository,
  CodespaceConnectionService,
  CodespaceProviderRegistry,
  CodespaceOperationRepository,
  CodespaceOperationService,
  CodespaceFileService,
  CodespaceTransferRepository,
  CodespaceTransferService,
  CodespaceResourceRepository,
  CodespaceResourceService,
  CodespaceObservabilityService,
  recordCodespaceConnectionEvent,
  recordCodespaceOperationEvent,
  recordCodespaceResourceEvent,
  getDatabase,
  getSqliteInstance,
  getCodespaceGitHubConfig,
  getCodespaceResourcePolicy,
  getDbPath,
  logAuditEventDirect,
  logAuditEventDirectOnce,
  createLogger,
  type CodespaceConnectionAuditEvent,
  type CodespaceResourceAuditEvent,
  type CodespaceOperationAuditEvent,
  type CodespaceGuidanceSituation,
} from "@mcp-moira/shared";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";

import { GitHubCodespacesConnector } from "./github-codespaces-connector.js";
import { OpenAINativeReferenceFetcher } from "./codespace-native-reference-fetcher.js";
import {
  GitHubCodespaceClientError,
  HttpGitHubCodespaceClient,
  githubCodespaceGuidance,
} from "./github-codespace-client.js";

interface CodespaceServices {
  connection: CodespaceConnectionService;
  resource: CodespaceResourceService | null;
  operation: CodespaceOperationService | null;
  file: CodespaceFileService | null;
  transfer: CodespaceTransferService;
  observability: CodespaceObservabilityService;
}

function operationAudit(
  auditRepository: AuditRepository,
): (event: CodespaceOperationAuditEvent) => Promise<void> {
  return async (event) => {
    recordCodespaceOperationEvent(event, event.updatedAt - event.createdAt);
    await logAuditEventDirect(auditRepository, {
      userId: event.userId,
      action: operationAuditAction(event),
      resource: "codespace_operation",
      resourceId: event.operationId,
      metadata: {
        codespaceId: event.codespaceId,
        provider: event.provider,
        state: event.state,
        kind: event.kind,
        inputBytes: event.inputBytes,
        outputBytes: event.outputBytes,
        exitCode: event.exitCode,
      },
    });
  };
}

let services: CodespaceServices | null = null;

function codespaceTransferRoot(): string {
  return migrateCodespaceTransferRoot(dirname(getDbPath()));
}

export function migrateCodespaceTransferRoot(parent: string): string {
  const current = join(parent, "codespace-transfers");
  // The table rename preserves live transfer rows. Move their short-lived objects with them so a
  // deployment during an active transfer does not leave the preserved row pointing at the old root.
  const legacy = join(parent, "workspace-transfers");
  if (!existsSync(legacy)) return current;
  if (!existsSync(current)) {
    renameSync(legacy, current);
    return current;
  }
  mkdirSync(current, { recursive: true });
  for (const entry of readdirSync(legacy)) {
    const source = join(legacy, entry);
    const target = join(current, entry);
    if (existsSync(target)) {
      throw new Error(`Cannot migrate legacy codespace transfer object: ${entry}`);
    }
    renameSync(source, target);
  }
  rmdirSync(legacy);
  return current;
}

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

function resourceAuditAction(event: CodespaceResourceAuditEvent): AuditAction {
  switch (event.action) {
    case "create":
      return AuditAction.CODESPACE_RESOURCE_CREATE;
    case "create_pending":
      return AuditAction.CODESPACE_RESOURCE_CREATE_PENDING;
    case "create_rejected":
      return AuditAction.CODESPACE_RESOURCE_CREATE_REJECTED;
    case "cleanup":
      return AuditAction.CODESPACE_RESOURCE_CLEANUP;
    case "start":
      return AuditAction.CODESPACE_RESOURCE_START;
    case "stop":
      return AuditAction.CODESPACE_RESOURCE_STOP;
    case "delete":
      return AuditAction.CODESPACE_RESOURCE_DELETE;
  }
}

function operationAuditAction(event: CodespaceOperationAuditEvent): AuditAction {
  switch (event.action) {
    case "reserve":
      return AuditAction.CODESPACE_OPERATION_RESERVE;
    case "reconcile":
      return AuditAction.CODESPACE_OPERATION_RECONCILE;
    case "terminal":
      return AuditAction.CODESPACE_OPERATION_TERMINAL;
  }
}

function initializeCodespaceServices(): CodespaceServices {
  if (services) return services;
  const codespaceLogger = createLogger({ component: "CodespaceTransfer" });
  const auditRepository = new AuditRepository(getDatabase());
  const config = getCodespaceGitHubConfig();
  let resource: CodespaceResourceService | null = null;
  let operation: CodespaceOperationService | null = null;
  let file: CodespaceFileService | null = null;
  const connection = new CodespaceConnectionService({
    repository: new CodespaceConnectionRepository(getSqliteInstance()),
    config: getCodespaceGitHubConfig,
    client: (availableConfig) => new HttpGitHubCodespaceClient(availableConfig),
    isProviderFailure: (error) => error instanceof GitHubCodespaceClientError,
    beforeDisconnect: async (userId) => {
      await resource?.cleanupBeforeDisconnect(userId);
    },
    afterConnect: async (userId) => {
      await resource?.rebindAfterAuthorization(userId);
    },
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

  const transfer = new CodespaceTransferService({
    repository: new CodespaceTransferRepository(getSqliteInstance()),
    policy: getCodespaceResourcePolicy,
    root: codespaceTransferRoot(),
    onCleanupError: (error) => codespaceLogger.error("Codespace transfer cleanup failed", error),
  });
  transfer.start();

  const resourceRepository = new CodespaceResourceRepository(getSqliteInstance());
  const operationRepository = new CodespaceOperationRepository(getSqliteInstance());
  let connector: GitHubCodespacesConnector | null = null;

  if (config.state === "available") {
    const availableConnector = new GitHubCodespacesConnector();
    connector = availableConnector;
    const provider = new HttpGitHubCodespaceClient(
      config,
      fetch,
      Date.now,
      () => availableConnector.health(),
      (credential, resourceName) =>
        availableConnector.probeSshConfiguration(credential, resourceName),
    );
    const registry = new CodespaceProviderRegistry();
    registry.register(provider);
    resource = new CodespaceResourceService({
      repository: resourceRepository,
      repositories: resourceRepository,
      registry,
      providerId: CODESPACE_PROVIDER_GITHUB,
      requiredCapabilities: {
        persistent: true,
        exactLifecycle: true,
        personalBillingOnly: true,
      },
      credentials: {
        getCredential: async (userId, providerId) => {
          if (providerId !== CODESPACE_PROVIDER_GITHUB) {
            throw new Error("Codespace credential provider does not match the service binding");
          }
          return connection.getAccessToken(userId);
        },
      },
      policy: getCodespaceResourcePolicy,
      audit: async (event) => {
        const context = {
          userId: event.userId,
          action: resourceAuditAction(event),
          resource: "codespace_resource",
          resourceId: event.resourceId,
          metadata: {
            provider: event.provider,
            outcome: event.outcome,
            ...(event.reason !== undefined ? { reason: event.reason } : {}),
            state: event.state,
            machine: event.machine,
          },
        };
        let inserted = true;
        if (event.dedupeKey === undefined) {
          await logAuditEventDirect(auditRepository, context);
        } else {
          inserted = await logAuditEventDirectOnce(auditRepository, {
            ...context,
            dedupeKey: event.dedupeKey,
          });
        }
        if (inserted) {
          recordCodespaceResourceEvent(event);
        }
      },
      controlAudit: async (event) => {
        await logAuditEventDirect(auditRepository, {
          userId: event.userId,
          action: AuditAction.CODESPACE_CONTROL_UPDATE,
          resource: "codespace_control",
          resourceId: event.scope,
          metadata: {
            provider: event.provider,
            scope: event.scope,
            disabled: event.disabled,
            reason: event.reason,
            stoppedPersistentCodespaces: event.stoppedPersistentCodespaces,
          },
        });
      },
    });
    const nativeFetcher = new OpenAINativeReferenceFetcher();
    operation = new CodespaceOperationService({
      repository: operationRepository,
      credentials: {
        getCredential: async (userId, providerId) => {
          if (providerId !== CODESPACE_PROVIDER_GITHUB) {
            throw new Error("Codespace credential provider does not match the service binding");
          }
          return connection.getAccessToken(userId);
        },
      },
      transport: connector,
      policy: getCodespaceResourcePolicy,
      transfers: transfer,
      nativeFetcher,
      lifecycle: {
        ensureRunning: (userId, codespaceId) => resource!.ensureRunning(userId, codespaceId),
      },
      audit: operationAudit(auditRepository),
    });
    file = new CodespaceFileService({
      repository: operationRepository,
      credentials: {
        getCredential: async (userId, providerId) => {
          if (providerId !== CODESPACE_PROVIDER_GITHUB) {
            throw new Error("Codespace credential provider does not match the service binding");
          }
          return connection.getAccessToken(userId);
        },
      },
      transport: connector,
      policy: getCodespaceResourcePolicy,
      transfers: transfer,
      nativeFetcher,
      lifecycle: {
        ensureRunning: (userId, codespaceId) => resource!.ensureRunning(userId, codespaceId),
      },
      audit: operationAudit(auditRepository),
    });
  }

  const observability = new CodespaceObservabilityService({
    providerId: CODESPACE_PROVIDER_GITHUB,
    config: getCodespaceGitHubConfig,
    policy: getCodespaceResourcePolicy,
    resources: resourceRepository,
    operations: operationRepository,
    transfers: new CodespaceTransferRepository(getSqliteInstance()),
    transport: connector,
    probeTimeoutMs: 2_000,
    snapshotMaxAgeMs: getCodespaceResourcePolicy().reconcileIntervalMs * 2,
  });

  services = { connection, resource, operation, file, transfer, observability };
  return services;
}

export function getCodespaceObservabilityService(): CodespaceObservabilityService {
  return initializeCodespaceServices().observability;
}

export function getCodespaceConnectionService(): CodespaceConnectionService {
  return initializeCodespaceServices().connection;
}

export function getCodespaceResourceService(): CodespaceResourceService | null {
  return initializeCodespaceServices().resource;
}

export function getCodespaceOperationService(): CodespaceOperationService | null {
  return initializeCodespaceServices().operation;
}

export function getCodespaceFileService(): CodespaceFileService | null {
  return initializeCodespaceServices().file;
}

export function getCodespaceTransferService(): CodespaceTransferService {
  return initializeCodespaceServices().transfer;
}

/** Guidance is available even when invalid configuration prevents runtime services from starting. */
export function getCodespaceSetupGuidance(situation: CodespaceGuidanceSituation) {
  const current = initializeCodespaceServices();
  if (current.resource) return current.resource.setupGuidance(situation);
  const config = getCodespaceGitHubConfig();
  const guidance = githubCodespaceGuidance(config);
  return {
    provider: CODESPACE_PROVIDER_GITHUB,
    situation,
    instruction: guidance.instructions[situation] ?? null,
    links: guidance.links,
  };
}
