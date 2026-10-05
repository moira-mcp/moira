import {
  AuditAction,
  AuditRepository,
  CODESPACE_PROVIDER_GITHUB,
  CODESPACE_PROVIDER_LOCAL,
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
  CodespaceResourceError,
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
  type CodespaceAvailableBillingView,
  type CodespaceProviderBillingView,
} from "@mcp-moira/shared";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";

import { GitHubCodespacesConnector } from "./github-codespaces-connector.js";
import { OpenAINativeReferenceFetcher } from "./codespace-native-reference-fetcher.js";
import { createLocalCodespaceServices } from "./local-codespace-services.js";
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
  local: ReturnType<typeof createLocalCodespaceServices>;
}

export type CodespaceProviderServices = Pick<
  CodespaceServices,
  "resource" | "operation" | "file" | "transfer" | "observability"
> & {
  provider: string;
  connection: Pick<CodespaceConnectionService, "getStatus" | "refreshGrants">;
  guidance: CodespaceResourceService["setupGuidance"];
};

/** A billing cache entry is valid only for one connected account and credential generation. */
export function createCodespaceBillingReader(dependencies: {
  connection: Pick<CodespaceConnectionService, "getStatus" | "getAccessToken">;
  authorization: (
    userId: string,
  ) => { accountId: string; credentialGeneration: number; status: string } | null;
  client: Pick<HttpGitHubCodespaceClient, "getMonthlyBilling"> | null;
  now?: () => number;
  waitMs?: number;
}): (userId: string, options?: { force?: boolean }) => Promise<CodespaceProviderBillingView> {
  const cache = new Map<string, { key: string; value: CodespaceAvailableBillingView }>();
  const inFlight = new Map<
    string,
    { key: string; promise: Promise<CodespaceProviderBillingView> }
  >();
  const now = dependencies.now ?? Date.now;
  const waitMs = dependencies.waitMs ?? 8_000;

  return async (userId, options = {}) => {
    const status = dependencies.connection.getStatus(userId);
    const authorization = dependencies.authorization(userId);
    if (
      status.state !== "connected" ||
      !status.account ||
      !dependencies.client ||
      authorization?.status !== "connected" ||
      authorization.accountId !== status.account.id
    ) {
      cache.delete(userId);
      inFlight.delete(userId);
      return "unavailable";
    }
    const account = status.account;
    const key = `${account.id}:${authorization.credentialGeneration}`;
    const cached = cache.get(userId);
    const date = new Date(now());
    if (
      !options.force &&
      cached?.key === key &&
      now() - cached.value.retrieved_at < 5 * 60_000 &&
      cached.value.period.year === date.getUTCFullYear() &&
      cached.value.period.month === date.getUTCMonth() + 1
    ) {
      return cached.value;
    }
    if (options.force || (cached && cached.key !== key)) cache.delete(userId);

    let pending = inFlight.get(userId);
    if (options.force || !pending || pending.key !== key) {
      const entry: { key: string; promise: Promise<CodespaceProviderBillingView> } = {
        key,
        promise: Promise.resolve("unavailable"),
      };
      entry.promise = (async () => {
        try {
          const token = await dependencies.connection.getAccessToken(userId);
          const result = await dependencies.client!.getMonthlyBilling(token, account);
          const current = dependencies.authorization(userId);
          const stillCurrent =
            inFlight.get(userId) === entry &&
            current?.status === "connected" &&
            current.accountId === account.id &&
            current.credentialGeneration === authorization.credentialGeneration;
          if (stillCurrent) {
            cache.set(userId, { key, value: result });
          }
          return stillCurrent ? result : "unavailable";
        } catch {
          if (inFlight.get(userId) === entry) cache.delete(userId);
          return "unavailable";
        } finally {
          if (inFlight.get(userId) === entry) inFlight.delete(userId);
        }
      })();
      inFlight.set(userId, entry);
      pending = entry;
    }

    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        pending.promise,
        new Promise<"unavailable">((resolve) => {
          timer = setTimeout(() => {
            if (inFlight.get(userId) === pending) {
              inFlight.delete(userId);
              cache.delete(userId);
            }
            resolve("unavailable");
          }, waitMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function resourceAudit(
  auditRepository: AuditRepository,
): (event: CodespaceResourceAuditEvent) => Promise<void> {
  return async (event) => {
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
  };
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
  let billingClient: HttpGitHubCodespaceClient | null = null;
  let operation: CodespaceOperationService | null = null;
  let file: CodespaceFileService | null = null;
  const connectionRepository = new CodespaceConnectionRepository(getSqliteInstance());
  const connection = new CodespaceConnectionService({
    repository: connectionRepository,
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
    billingClient = provider;
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
      refreshAuthorization: async (userId) => {
        const result = await connection.refreshGrants(userId, { force: true });
        return !result.stale;
      },
      audit: resourceAudit(auditRepository),
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
      providerId: CODESPACE_PROVIDER_GITHUB,
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

  const readBilling = createCodespaceBillingReader({
    connection,
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
    client: billingClient,
  });

  const observability = new CodespaceObservabilityService({
    providerId: CODESPACE_PROVIDER_GITHUB,
    config: getCodespaceGitHubConfig,
    policy: getCodespaceResourcePolicy,
    resources: resourceRepository,
    operations: operationRepository,
    transfers: new CodespaceTransferRepository(getSqliteInstance()),
    transport: connector,
    providerBilling: readBilling,
    probeTimeoutMs: 2_000,
    snapshotMaxAgeMs: getCodespaceResourcePolicy().reconcileIntervalMs * 2,
  });

  const local = createLocalCodespaceServices(transfer, {
    resourceAudit: resourceAudit(auditRepository),
    operationAudit: operationAudit(auditRepository),
  });
  services = { connection, resource, operation, file, transfer, observability, local };
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

export function getLocalDeviceService() {
  return initializeCodespaceServices().local.devices;
}

export function getCodespaceProviderServices(provider: string): CodespaceProviderServices {
  const current = initializeCodespaceServices();
  if (provider === CODESPACE_PROVIDER_LOCAL) {
    return {
      ...current.local,
      provider,
      guidance: (situation) => current.local.resource.setupGuidance(situation),
    };
  }
  if (provider !== CODESPACE_PROVIDER_GITHUB) throw new Error("Unknown codespace provider");
  return { ...current, provider, guidance: getCodespaceSetupGuidance };
}

export function getCodespaceProviderBundles(): CodespaceProviderServices[] {
  return [
    getCodespaceProviderServices(CODESPACE_PROVIDER_GITHUB),
    getCodespaceProviderServices(CODESPACE_PROVIDER_LOCAL),
  ];
}

export function selectCodespaceProviderServices(
  userId: string,
  input: { repositoryId?: string; codespaceId?: string },
): CodespaceProviderServices {
  if (input.codespaceId !== undefined) {
    const resource = new CodespaceResourceRepository(getSqliteInstance()).getOwned(
      userId,
      input.codespaceId,
    );
    if (!resource)
      throw new CodespaceResourceError(
        "CODESPACE_NOT_FOUND",
        "Codespace is not owned by this caller",
      );
    return getCodespaceProviderServices(resource.provider);
  }
  return getCodespaceProviderServices(
    input.repositoryId?.startsWith("local:") ? CODESPACE_PROVIDER_LOCAL : CODESPACE_PROVIDER_GITHUB,
  );
}

export function startCodespaceProviderServices(): void {
  for (const bundle of getCodespaceProviderBundles()) {
    bundle.resource?.start();
    bundle.operation?.start();
  }
}

export function stopCodespaceProviderServices(): void {
  for (const bundle of getCodespaceProviderBundles()) {
    bundle.resource?.stop();
    bundle.operation?.stop();
  }
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
