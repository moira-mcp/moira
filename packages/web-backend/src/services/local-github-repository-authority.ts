import {
  CODESPACE_PROVIDER_GITHUB,
  CodespaceConnectionRepository,
  CodespaceConnectionError,
  getSqliteInstance,
  getCodespaceGitHubConfig,
  LocalDeviceError,
  type RepositoryCreationAuthority,
  type GitHubCodespaceInstallation,
} from "@mcp-moira/shared";
import { getCodespaceConnectionService } from "./codespace-services.js";
import {
  HttpGitHubCodespaceClient,
  GitHubCodespaceClientError,
} from "./github-codespace-client.js";

export function personalGitHubInstallations(
  installations: GitHubCodespaceInstallation[],
  authority: RepositoryCreationAuthority,
): GitHubCodespaceInstallation[] {
  return installations.filter(
    (installation) =>
      installation.targetType === "User" &&
      installation.accountId === authority.githubUserId &&
      installation.accountLogin.toLowerCase() === authority.owner.toLowerCase(),
  );
}

/** Fixed GitHub destinations and current App account; construction never performs provider I/O. */
export function createLocalGitHubRepositoryAuthority() {
  const connections = new CodespaceConnectionRepository(getSqliteInstance());
  const account = (userId: string) => {
    const value = connections.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    if (value?.status !== "connected")
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Connect GitHub in Moira Settings first.");
    return value;
  };
  const currentAuthority = (userId: string): RepositoryCreationAuthority => {
    const value = account(userId);
    return {
      githubConnectionId: value.id,
      githubUserId: value.externalAccountId,
      owner: value.externalLogin,
      credentialGeneration: value.credentialGeneration,
    };
  };
  const provider = () => {
    const config = getCodespaceGitHubConfig();
    if (config.state !== "available")
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Configure the Moira GitHub App before creating repositories.",
      );
    return new HttpGitHubCodespaceClient(config);
  };
  const knownSetup = (error: unknown): never => {
    if (error instanceof CodespaceConnectionError || error instanceof GitHubCodespaceClientError)
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Refresh GitHub App access and required permissions in Moira Settings.",
      );
    throw error;
  };
  const authorize = async (userId: string, installationId?: string) => {
    try {
      const client = provider();
      const connection = getCodespaceConnectionService();
      if ((await connection.refreshGrants(userId, { force: true })).stale)
        throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Refresh GitHub App repository access.");
      const accessToken = await connection.getAccessToken(userId);
      const before = currentAuthority(userId);
      const installations = personalGitHubInstallations(
        await client.listInstallations(accessToken),
        before,
      );
      const after = currentAuthority(userId);
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "GitHub account changed during installation discovery.",
        );
      const selected = installationId
        ? installations.find((installation) => installation.id === installationId)
        : null;
      if (installationId && !selected)
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "Select a personal installation of the connected Moira GitHub App.",
        );
      return {
        authority: after,
        accessToken,
        installations,
        repositorySelection: selected?.repositorySelection ?? ("selected" as "all" | "selected"),
      };
    } catch (error) {
      return knownSetup(error);
    }
  };
  return {
    provider,
    currentAuthority,
    authorize,
    async listInstallations(userId: string) {
      const verified = await authorize(userId);
      return verified.installations.map((installation) => ({
        installation_id: installation.id,
        owner: installation.accountLogin,
        repository_selection: installation.repositorySelection,
      }));
    },
    async verifyInstallation(userId: string, installationId: string, repositoryId: string) {
      await authorize(userId, installationId);
      const verified = account(userId).repositories.find(
        (repository) =>
          repository.externalInstallationId === installationId &&
          repository.externalRepositoryId === repositoryId &&
          repository.private,
      );
      if (!verified)
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "The new repository is not yet accessible to the selected Moira App installation.",
        );
    },
    links() {
      const config = getCodespaceGitHubConfig();
      return {
        settings: config.settingsUrl,
        installation: config.state === "available" ? config.installationUrl : null,
      };
    },
  };
}
