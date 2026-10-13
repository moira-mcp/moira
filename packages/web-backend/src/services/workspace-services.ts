import {
  CodespaceResourceRepository,
  CodespaceResourceError,
  CODESPACE_PROVIDER_LOCAL,
  getBaseUrl,
  getSqliteInstance,
  getCodespaceResourcePolicy,
  localPublicPolicySchema,
  getAccountAccessDenial,
  WorkspaceAuthRepository,
  type WorkspaceAgentBinding,
} from "@mcp-moira/shared";
import {
  getCodespaceProviderServices,
  getCodespaceConnectionService,
  bootstrapLocalWorkspace,
} from "./codespace-services.js";
import { GitHubCodespacesConnector } from "./github-codespaces-connector.js";
import { WorkspaceRouter } from "./workspace-router.js";
import { WORKSPACE_ROUTER_SOCKET } from "./workspace-client.js";

let router: WorkspaceRouter | undefined;
const bootstrapping = new Map<string, Promise<void>>();

function currentAuthority(userId: string, resourceId: string, requireRunning = true) {
  const sqlite = getSqliteInstance();
  const resources = new CodespaceResourceRepository(sqlite);
  const resource = resources.getOwned(userId, resourceId);
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
    ) ||
    !resource ||
    !resources.hasCurrentAuthorization(userId, resourceId) ||
    (requireRunning && resource.desiredState !== "running") ||
    ["deleted", "delete_pending", "rejected", "cleanup_pending", "stop_pending"].includes(
      resource.state,
    )
  )
    throw new CodespaceResourceError(
      "CODESPACE_AUTHORIZATION_REQUIRED",
      "Workspace authority refused",
    );
  const disabled = sqlite
    .prepare("SELECT 1 FROM codespaceProviderControl WHERE disabled=1 AND scope IN ('global',?)")
    .get(`provider:${resource.provider}`);
  if (
    disabled ||
    (resource.provider !== CODESPACE_PROVIDER_LOCAL && !getCodespaceResourcePolicy().enabled)
  )
    throw new CodespaceResourceError("CODESPACE_PROVIDER_DISABLED", "Workspace provider disabled");
  let expiresAt: number | null = null;
  if (resource.provider === CODESPACE_PROVIDER_LOCAL) {
    const device = sqlite
      .prepare(
        `SELECT d.policy,b.repositoryId,b.profileId FROM codespaceLocalResourceBinding b
      JOIN codespaceLocalDevice d ON d.id=b.deviceId AND d.userId=b.userId AND d.generation=b.deviceGeneration
      WHERE b.resourceId=? AND b.userId=? AND d.status='active'`,
      )
      .get(resourceId, userId) as
      { policy: string; repositoryId: string; profileId: string } | undefined;
    if (!device)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Workspace device authority refused",
      );
    const policy = localPublicPolicySchema.parse(JSON.parse(device.policy));
    if (
      !policy.enabled ||
      policy.leaseUntil <= Date.now() ||
      !policy.repositories.some((r) => r.id === device.repositoryId)
    )
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "Workspace device grant expired",
      );
    expiresAt = policy.leaseUntil;
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
    resourceId,
    resourceGeneration: binding.resourceGeneration,
    authorizationGeneration: binding.authorizationGeneration,
    environmentIdentity,
    credential,
  };
}

function requireBinding(binding: WorkspaceAgentBinding, credentialExpiresAt: number | null = null) {
  const { resource, expiresAt } = currentAuthority(binding.userId, binding.resourceId);
  if (
    resource.generation !== binding.resourceGeneration ||
    resource.authorizationGeneration !== binding.authorizationGeneration
  )
    throw new CodespaceResourceError(
      "CODESPACE_GENERATION_CONFLICT",
      "Workspace generation changed",
    );
  return {
    ...binding,
    expiresAt:
      credentialExpiresAt === null
        ? expiresAt
        : expiresAt === null
          ? credentialExpiresAt
          : Math.min(credentialExpiresAt, expiresAt),
  };
}

export function getWorkspaceRouter(): WorkspaceRouter {
  return (router ??= new WorkspaceRouter({
    async credential(value) {
      const record = new WorkspaceAuthRepository(getSqliteInstance()).authenticate(value);
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
    async request(userId, resourceId, signal) {
      const { resource } = currentAuthority(userId, resourceId, false);
      const lifecycle = getCodespaceProviderServices(resource.provider).resource;
      if (!lifecycle)
        throw new CodespaceResourceError(
          "CODESPACE_PROVIDER_UNAVAILABLE",
          "Workspace provider unavailable",
        );
      await lifecycle.ensureRunning(userId, resourceId);
      const currentResource = currentAuthority(userId, resourceId).resource;
      let record = new WorkspaceAuthRepository(getSqliteInstance()).getOwned(userId, resourceId);
      if (
        !record ||
        record.resourceGeneration !== currentResource.generation ||
        record.authorizationGeneration !== currentResource.authorizationGeneration ||
        (record.expiresAt !== null && record.expiresAt <= Date.now()) ||
        !getWorkspaceRouter().isConnected(record)
      ) {
        const key = `${userId}:${resourceId}`;
        let pending = bootstrapping.get(key);
        if (!pending) {
          pending = (async () => {
            const original = currentAuthority(userId, resourceId).resource;
            if (original.provider === CODESPACE_PROVIDER_LOCAL) {
              await bootstrapLocalWorkspace(userId, resourceId);
            } else {
              if (!original.providerResourceName)
                throw new Error("Workspace provider identity unavailable");
              const connector = new GitHubCodespacesConnector();
              const access = await getCodespaceConnectionService().getAccessToken(userId);
              const measured = await connector.probeWorkspace(
                access,
                original.providerResourceName,
              );
              const current = currentAuthority(userId, resourceId).resource;
              if (
                current.generation !== original.generation ||
                current.authorizationGeneration !== original.authorizationGeneration
              )
                throw new Error("Workspace bootstrap authority changed");
              const root = Buffer.from(measured.rootBase64, "base64").toString("utf8");
              if (
                !root.startsWith("/") ||
                root.includes("\0") ||
                Buffer.from(root).toString("base64") !== measured.rootBase64
              )
                throw new Error("Invalid workspace root observation");
              const remote = issueWorkspaceAgentCredential(
                userId,
                resourceId,
                measured.environmentIdentity,
              );
              await connector.bootstrapWorkspace(access, original.providerResourceName, {
                version: 1,
                repositoryFullName: original.repositoryFullName,
                root,
                remote,
              });
            }
            const current = new WorkspaceAuthRepository(getSqliteInstance()).getOwned(
              userId,
              resourceId,
            );
            if (!current) throw new Error("Workspace bootstrap did not establish authority");
            requireBinding(current);
          })().finally(() => bootstrapping.delete(key));
          bootstrapping.set(key, pending);
        }
        await pending;
        record = new WorkspaceAuthRepository(getSqliteInstance()).getOwned(userId, resourceId);
      }
      if (!record || (record.expiresAt !== null && record.expiresAt <= Date.now()))
        throw new Error("Workspace is not bootstrapped");
      const binding = requireBinding({
        userId,
        resourceId,
        resourceGeneration: record.resourceGeneration,
        authorizationGeneration: record.authorizationGeneration,
        environmentIdentity: record.environmentIdentity,
      });
      await getWorkspaceRouter().waitForConnection(binding, signal);
      return requireBinding(binding);
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
