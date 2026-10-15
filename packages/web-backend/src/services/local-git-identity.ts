import {
  CODESPACE_PROVIDER_GITHUB,
  LocalDeviceError,
  type CodespaceConnectionService,
  type CodespaceConnectionRepository,
  type LocalDeviceAuth,
  type LocalPublicPolicy,
} from "@mcp-moira/shared";

export interface LocalGitIdentityDependencies {
  connection: Pick<CodespaceConnectionService, "refreshGrants">;
  connections: Pick<CodespaceConnectionRepository, "getConnection">;
  authorize: (
    auth: LocalDeviceAuth,
    resourceId: string,
    generation: number,
  ) =>
    LocalPublicPolicy["repositories"][number] | Promise<LocalPublicPolicy["repositories"][number]>;
}

/** Verified author metadata only; Git bytes and PR effects belong to the workspace owner. */
export class LocalGitIdentity {
  constructor(private readonly dependencies: LocalGitIdentityDependencies) {}

  async identity(auth: LocalDeviceAuth, resourceId: string, generation: number) {
    await this.dependencies.authorize(auth, resourceId, generation);
    const refreshed = await this.dependencies.connection.refreshGrants(auth.userId);
    if (refreshed.stale)
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Refresh GitHub repository access in Settings.",
      );
    const repository = await this.dependencies.authorize(auth, resourceId, generation);
    const connection = this.dependencies.connections.getConnection(
      auth.userId,
      CODESPACE_PROVIDER_GITHUB,
    );
    const granted = connection?.repositories.find(
      (entry) =>
        entry.fullName.toLowerCase() === repository.fullName.toLowerCase() &&
        entry.private === repository.private,
    );
    if (
      connection?.status !== "connected" ||
      !granted ||
      !connection.installations.some(
        (entry) => entry.externalInstallationId === granted.externalInstallationId,
      )
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Add this repository to the Moira GitHub App installation in Settings.",
      );
    if (
      !/^[0-9]+$/.test(connection.externalAccountId) ||
      !/^[A-Za-z0-9-]{1,39}$/.test(connection.externalLogin)
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Reconnect GitHub to restore the verified commit identity.",
      );
    return {
      name: connection.externalLogin,
      email: `${connection.externalAccountId}+${connection.externalLogin}@users.noreply.github.com`,
    };
  }
}
