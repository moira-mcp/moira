import {
  CODESPACE_PROVIDER_LOCAL,
  CodespaceConnectionRepository,
  LocalResourceRepository,
  LocalDeviceRepository,
  LocalDeviceService,
  getBaseUrl,
  codespaceGitHubSettingsPath,
  getSqliteInstance,
  getCodespaceResourcePolicy,
  type CodespaceConnectionView,
  type CodespaceConnectionService,
  type CodespaceResourcePolicy,
  type CodespaceReadinessView,
  LocalDeviceError,
  CODESPACE_PROVIDER_GITHUB,
} from "@mcp-moira/shared";
import { LocalCodespaceProvider } from "./local-codespace-provider.js";
import { LocalCodespaceResourceService } from "./local-codespace-resource-service.js";
import { getWorkspaceClient, getControllerClient } from "./workspace-client.js";

export function localCodespaceSettingsUrl(baseUrl = getBaseUrl(), appPrefix?: string): string {
  const url = new URL(codespaceGitHubSettingsPath(appPrefix), baseUrl);
  url.hash = "integrations-local";
  return url.toString();
}
export function localCodespacePolicy() {
  return { ...getCodespaceResourcePolicy(), enabled: true };
}
export function createLocalCodespaceServices(
  context: {
    sqlite?: ReturnType<typeof getSqliteInstance>;
    now?: () => number;
    policy?: () => CodespaceResourcePolicy;
    settingsUrl?: string;
    controller?: ConstructorParameters<typeof LocalDeviceService>[2];
    github?: Pick<CodespaceConnectionService, "refreshGrants">;
    retireDeviceCredentials?: ConstructorParameters<typeof LocalDeviceService>[3];
  } = {},
) {
  const sqlite = context.sqlite ?? getSqliteInstance(),
    now = context.now ?? Date.now;
  const devices = new LocalDeviceService(
    new LocalDeviceRepository(sqlite),
    now,
    context.controller ?? getControllerClient(),
    context.retireDeviceCredentials,
  );
  const resources = new LocalResourceRepository(sqlite),
    connections = new CodespaceConnectionRepository(sqlite);
  const settingsUrl = context.settingsUrl ?? localCodespaceSettingsUrl();
  const provider = new LocalCodespaceProvider(devices, resources, settingsUrl, now);
  const resource = new LocalCodespaceResourceService(
    resources,
    devices,
    provider,
    sqlite,
    now,
    async (userId, repository) => {
      if (!context.github || (await context.github.refreshGrants(userId, { force: true })).stale)
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "Refresh GitHub repository authority before registering this resource.",
        );
      const account = connections.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
      const grant = account?.repositories.find(
        (entry) =>
          entry.fullName.toLowerCase() === repository.fullName.toLowerCase() &&
          entry.private === repository.private,
      );
      if (
        account?.status !== "connected" ||
        !grant ||
        !account.installations.some(
          (entry) => entry.externalInstallationId === grant.externalInstallationId,
        )
      )
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "The selected GitHub App does not admit this repository.",
        );
    },
  );
  const observability = {
    async readiness(): Promise<CodespaceReadinessView> {
      return {
        provider: CODESPACE_PROVIDER_LOCAL,
        state: "ready",
        reason: null,
        configuration: "available",
        resources_enabled: true,
        checked_at: now(),
      };
    },
  };
  const connection: Pick<CodespaceConnectionService, "getStatus" | "refreshGrants"> = {
    getStatus(userId): CodespaceConnectionView {
      const active = devices
        .listRegistered(userId)
        .devices.filter((device) => device.status === "active");
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
        repositories: [],
        canConnect: true,
        canDisconnect: false,
      };
    },
    async refreshGrants(userId) {
      const owned = await devices.listOwned(userId);
      return {
        refreshed: true,
        stale: owned.devices.some(
          (device) => device.status === "active" && device.owner.state !== "available",
        ),
      };
    },
  };
  return {
    connection,
    resource,
    workspace: getWorkspaceClient(),
    observability,
    devices,
    provider,
  };
}
