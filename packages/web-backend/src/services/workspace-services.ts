import {
  LocalResourceRepository,
  GitHubResourceRepository,
  CODESPACE_PROVIDER_GITHUB,
  CodespaceResourceError,
  CODESPACE_PROVIDER_LOCAL,
  getBaseUrl,
  getSqliteInstance,
  getCodespaceResourcePolicy,
  LocalDeviceService,
  LocalDeviceRepository,
  getAccountAccessDenial,
  WorkspaceAuthRepository,
  type WorkspaceAgentBinding,
} from "@mcp-moira/shared";
import { WorkspaceRouter } from "./workspace-router.js";
import type { WorkspaceBinding } from "./workspace-router.js";
import { WORKSPACE_ROUTER_SOCKET } from "./workspace-client.js";

let router: WorkspaceRouter | undefined;

function requireAccount(userId: string) {
  const sqlite = getSqliteInstance();
  const account = sqlite
    .prepare("SELECT id userId,blocked,approvedAt,emailVerified FROM user WHERE id=?")
    .get(userId) as
    | { userId: string; blocked: number; approvedAt: string | null; emailVerified: number }
    | undefined;
  if (
    !account ||
    getAccountAccessDenial(
      {
        ...account,
        blocked: Boolean(account.blocked),
        emailVerified: Boolean(account.emailVerified),
      },
      { requireEmailVerified: true },
    )
  )
    throw new CodespaceResourceError(
      "CODESPACE_AUTHORIZATION_REQUIRED",
      "Account authority refused",
    );
}

function currentAuthority(userId: string, resourceId: string) {
  const sqlite = getSqliteInstance();
  const resources = new LocalResourceRepository(sqlite);
  const githubResources = new GitHubResourceRepository(sqlite),
    github = githubResources.getOwned(userId, resourceId),
    local = github ? null : resources.getOwned(userId, resourceId),
    resource = github
      ? { ...github, provider: CODESPACE_PROVIDER_GITHUB }
      : local
        ? { ...local, provider: CODESPACE_PROVIDER_LOCAL, generation: local.routeGeneration }
        : null;
  requireAccount(userId);
  if (
    !resource ||
    (local?.retiredAt !== undefined && local.retiredAt !== null) ||
    (resource.provider !== CODESPACE_PROVIDER_LOCAL &&
      (!githubResources.hasCurrentAuthorization(userId, resourceId) ||
        github?.retirement === "retired"))
  )
    throw new CodespaceResourceError(
      "CODESPACE_AUTHORIZATION_REQUIRED",
      "Workspace authority refused",
    );
  if (resource.provider !== CODESPACE_PROVIDER_LOCAL && !getCodespaceResourcePolicy().enabled)
    throw new CodespaceResourceError("CODESPACE_PROVIDER_DISABLED", "Workspace provider disabled");
  const expiresAt: number | null = null;
  if (github) {
    if (!github.deviceId)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "A controller must prove this workspace assignment",
      );
    const device = new LocalDeviceService(new LocalDeviceRepository(sqlite)).getDeviceIdentity(
      userId,
      github.deviceId,
    );
    if (
      device.status !== "active" ||
      device.deviceGeneration !== github.deviceGeneration ||
      device.connectionId !== github.deviceConnectionId
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Assigned controller authority changed",
      );
  }
  if (resource.provider === CODESPACE_PROVIDER_LOCAL) {
    const device = sqlite
      .prepare(
        `SELECT b.repositoryId,b.profileId FROM codespaceLocalResourceBinding b
      JOIN localResourceIdentity r ON r.id=b.resourceId AND r.userId=b.userId
      JOIN codespaceLocalDevice d ON d.id=b.deviceId AND d.userId=b.userId AND d.generation=b.deviceGeneration AND d.connectionId=r.connectionId
      JOIN codespaceConnection c ON c.id=r.connectionId AND c.userId=r.userId AND c.status='connected'
      WHERE b.resourceId=? AND b.userId=? AND b.revokedAt IS NULL AND d.status='active' AND r.retiredAt IS NULL`,
      )
      .get(resourceId, userId) as { repositoryId: string; profileId: string } | undefined;
    if (!device)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Workspace device authority refused",
      );
  }
  return { resource, expiresAt };
}

/** Called only by fixed provider bootstrap after it has measured the original guest life. */
export function issueWorkspaceAgentCredential(
  userId: string,
  resourceId: string,
  environmentIdentity: string,
) {
  if (!/^[a-f0-9]{64}$/.test(environmentIdentity))
    throw new Error("Invalid measured workspace life");
  const { resource, expiresAt } = currentAuthority(userId, resourceId);
  const binding: WorkspaceAgentBinding = {
    userId,
    resourceId,
    resourceGeneration: resource.generation,
    authorizationGeneration: resource.authorizationGeneration,
    environmentIdentity,
  };
  const credential = new WorkspaceAuthRepository(getSqliteInstance()).issue(binding, expiresAt);
  return {
    version: 1 as const,
    origin: new URL(getBaseUrl()).origin,
    publicOrigin: getBaseUrl(),
    resourceId,
    resourceGeneration: binding.resourceGeneration,
    authorizationGeneration: binding.authorizationGeneration,
    environmentIdentity,
    credential,
  };
}

function requireBinding(
  binding: WorkspaceAgentBinding,
  credentialExpiresAt: number | null = null,
  authority = currentAuthority(binding.userId, binding.resourceId),
) {
  const { resource, expiresAt } = authority;
  if (
    resource.generation !== binding.resourceGeneration ||
    resource.authorizationGeneration !== binding.authorizationGeneration
  )
    throw new CodespaceResourceError(
      "CODESPACE_GENERATION_CONFLICT",
      "Workspace generation changed",
    );
  return {
    kind: "workspace" as const,
    ...binding,
    expiresAt:
      credentialExpiresAt === null
        ? expiresAt
        : expiresAt === null
          ? credentialExpiresAt
          : Math.min(credentialExpiresAt, expiresAt),
  };
}

/** Authenticate the enrolled actor independently of its live dispatch connection. */
export async function authorizeWorkspaceAgentCredential(
  credential: string,
  resourceId: string,
  resourceGeneration: number,
) {
  const record = new WorkspaceAuthRepository(getSqliteInstance()).authenticate(credential);
  if (record.resourceId !== resourceId || record.resourceGeneration !== resourceGeneration)
    throw new CodespaceResourceError(
      "CODESPACE_GENERATION_CONFLICT",
      "Workspace credential identity changed",
    );
  return requireBinding(record, record.expiresAt);
}

/** A public owner capability can route only to an already enrolled, currently authorized guest. */
export async function authorizeWorkspacePublication(resourceId: string): Promise<string> {
  const sqlite = getSqliteInstance();
  const route = sqlite
    .prepare(
      "SELECT userId FROM localResourceIdentity WHERE id=@resourceId UNION ALL SELECT userId FROM githubResourceIdentity WHERE id=@resourceId",
    )
    .get({ resourceId }) as { userId: string } | undefined;
  if (!route)
    throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Publication route unavailable");
  const authority = currentAuthority(route.userId, resourceId);
  const record = new WorkspaceAuthRepository(sqlite).getOwned(route.userId, resourceId);
  if (!record || (record.expiresAt !== null && record.expiresAt <= Date.now()))
    throw new CodespaceResourceError(
      "CODESPACE_PROVIDER_UNAVAILABLE",
      "Publication owner unavailable",
    );
  requireBinding(record, record.expiresAt, authority);
  return route.userId;
}

function currentControllerAuthority(userId: string, deviceId: string): WorkspaceBinding {
  requireAccount(userId);
  const device = new LocalDeviceService(
    new LocalDeviceRepository(getSqliteInstance()),
  ).getDeviceIdentity(userId, deviceId);
  if (device.status !== "active")
    throw new CodespaceResourceError(
      "CODESPACE_AUTHORIZATION_REQUIRED",
      "Controller device authority refused",
    );
  return {
    kind: "controller",
    userId: device.userId,
    resourceId: device.deviceId,
    resourceGeneration: device.deviceGeneration,
    authorizationGeneration: device.deviceGeneration,
    connectionId: device.connectionId,
    expiresAt: null,
  };
}

export function getWorkspaceRouter(): WorkspaceRouter {
  return (router ??= new WorkspaceRouter({
    async credential(value) {
      let record;
      try {
        record = new WorkspaceAuthRepository(getSqliteInstance()).authenticate(value);
      } catch {
        const device = new LocalDeviceService(
          new LocalDeviceRepository(getSqliteInstance()),
        ).authenticateDevice(value);
        const binding = currentControllerAuthority(device.userId, device.deviceId);
        if (
          binding.kind !== "controller" ||
          binding.resourceGeneration !== device.deviceGeneration ||
          binding.connectionId !== device.connectionId
        )
          throw new CodespaceResourceError(
            "CODESPACE_AUTHORIZATION_REQUIRED",
            "Controller device generation changed",
          );
        return binding;
      }
      return requireBinding(
        {
          userId: record.userId,
          resourceId: record.resourceId,
          resourceGeneration: record.resourceGeneration,
          authorizationGeneration: record.authorizationGeneration,
          environmentIdentity: record.environmentIdentity,
        },
        record.expiresAt,
      );
    },
    async request(userId, resourceId, _signal, kind = "workspace") {
      if (kind === "controller") return currentControllerAuthority(userId, resourceId);
      const authority = currentAuthority(userId, resourceId);
      const record = new WorkspaceAuthRepository(getSqliteInstance()).getOwned(userId, resourceId);
      if (!record || (record.expiresAt !== null && record.expiresAt <= Date.now()))
        throw new CodespaceResourceError(
          "CODESPACE_PROVIDER_UNAVAILABLE",
          "Workspace owner has not enrolled a current service; no operation was dispatched",
        );
      return requireBinding(record, record.expiresAt, authority);
    },
  }));
}

export async function startWorkspaceRouter(server: import("node:http").Server): Promise<void> {
  const current = getWorkspaceRouter();
  await current.listenPrivate(WORKSPACE_ROUTER_SOCKET);
  current.attach(server);
}

export async function stopWorkspaceRouter(): Promise<void> {
  await router?.close();
  router = undefined;
}
