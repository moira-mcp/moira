import {
  CODESPACE_PROVIDER_LOCAL,
  CodespaceConnectionRepository,
  CodespaceResourceRepository,
  CodespaceResourceService,
  CodespaceObservabilityService,
  CodespaceProviderRegistry,
  LocalDeviceRepository,
  LocalDeviceService,
  localRepositoryTargetId,
  getBaseUrl,
  codespaceGitHubSettingsPath,
  getSqliteInstance,
  getCodespaceResourcePolicy,
  recordCodespaceResourceEvent,
  type CodespaceConnectionView,
  type CodespaceConnectionService,
  type CodespaceTransferService,
  type CodespaceResourcePolicy,
  type CodespaceResourceAuditEvent,
} from "@mcp-moira/shared";
import { LocalCodespaceRelay } from "./local-codespace-relay.js";
import { LocalCodespaceProvider, localCodespaceCredential } from "./local-codespace-provider.js";
import { getWorkspaceClient } from "./workspace-client.js";

export function localCodespaceSettingsUrl(baseUrl = getBaseUrl(), appPrefix?: string): string {
  const url = new URL(codespaceGitHubSettingsPath(appPrefix), baseUrl);
  url.hash = "integrations-local";
  return url.toString();
}

export function localCodespacePolicy() {
  return { ...getCodespaceResourcePolicy(), enabled: true };
}

export function createLocalCodespaceServices(
  transfer: CodespaceTransferService,
  context: {
    sqlite?: ReturnType<typeof getSqliteInstance>;
    now?: () => number;
    policy?: () => CodespaceResourcePolicy;
    settingsUrl?: string;
    resourceAudit?: (event: CodespaceResourceAuditEvent) => Promise<void> | void;
  } = {},
) {
  const sqlite = context.sqlite ?? getSqliteInstance();
  const now = context.now ?? Date.now;
  const policy = context.policy ?? localCodespacePolicy;
  const devices = new LocalDeviceService(new LocalDeviceRepository(sqlite), now);
  const resources = new CodespaceResourceRepository(sqlite);
  const connections = new CodespaceConnectionRepository(sqlite);
  const settingsUrl = context.settingsUrl ?? localCodespaceSettingsUrl();
  const relay = new LocalCodespaceRelay(devices, now);
  const provider = new LocalCodespaceProvider(relay, resources, settingsUrl, now);
  const registry = new CodespaceProviderRegistry();
  registry.register(provider);
  const credentials = {
    getCredential: async (userId: string, providerId: string) => {
      if (providerId !== CODESPACE_PROVIDER_LOCAL)
        throw new Error("Local credential provider does not match");
      devices.listOwned(userId);
      return localCodespaceCredential(userId);
    },
  };
  const resource = new CodespaceResourceService({
    repository: resources,
    repositories: resources,
    registry,
    credentials,
    providerId: CODESPACE_PROVIDER_LOCAL,
    requiredCapabilities: { persistent: true, exactLifecycle: true, personalBillingOnly: true },
    policy,
    now,
    refreshAuthorization: async (userId) => {
      devices.listOwned(userId);
      return true;
    },
    audit: context.resourceAudit ?? recordCodespaceResourceEvent,
  });
  const observability = new CodespaceObservabilityService({
    providerId: CODESPACE_PROVIDER_LOCAL,
    config: () => ({ state: "available" }),
    policy,
    now,
    resources,
    transport: {
      async health() {
        const current = await provider.health();
        return { ok: current.state === "available", reason: current.reason };
      },
    },
  });
  const connection: Pick<CodespaceConnectionService, "getStatus" | "refreshGrants"> = {
    getStatus(userId): CodespaceConnectionView {
      const owned = devices.listOwned(userId);
      const active = owned.devices.filter((device) => device.status === "active");
      const stored = connections.getConnection(userId, CODESPACE_PROVIDER_LOCAL);
      return {
        state:
          stored?.status === "connected" && active.length > 0 ? "connected" : "connection_required",
        reason: active.length > 0 ? null : "LOCAL_DEVICE_REQUIRED",
        settingsUrl,
        installationUrl: null,
        account: active.length > 0 ? { id: userId, login: "local" } : null,
        installations: active.map((device) => ({
          externalInstallationId: device.deviceId,
          repositorySelection: "selected",
        })),
        repositories: active.flatMap((device) =>
          device.policy.repositories.map((repo) => ({
            externalRepositoryId: localRepositoryTargetId(device.deviceId, repo.id),
            fullName: repo.fullName,
            private: repo.private,
          })),
        ),
        canConnect: true,
        canDisconnect: false,
      };
    },
    async refreshGrants(userId) {
      devices.listOwned(userId);
      return { refreshed: false, stale: false };
    },
  };
  return {
    connection,
    resource,
    workspace: getWorkspaceClient(),
    observability,
    devices,
    relay,
    provider,
    transfer,
  };
}
