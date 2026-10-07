import {
  CODESPACE_PROVIDER_GITHUB,
  CodespaceConnectionRepository,
  getSqliteInstance,
  LocalDeviceError,
} from "@mcp-moira/shared";
import { getCodespaceConnectionService, getLocalDeviceService } from "./codespace-services.js";
import { LocalRepositoryAdmissionService } from "./local-repository-admission.js";
import { createLocalGitHubRepositoryAuthority } from "./local-github-repository-authority.js";
import { GitHubCodespaceClientError } from "./github-codespace-client.js";

function createAdmissionService() {
  const connections = new CodespaceConnectionRepository(getSqliteInstance());
  const connection = getCodespaceConnectionService();
  const githubAuthority = createLocalGitHubRepositoryAuthority();
  const requireAccount = (userId: string) => {
    const account = connections.getConnection(userId, CODESPACE_PROVIDER_GITHUB);
    if (account?.status !== "connected" || !/^[1-9][0-9]*$/.test(account.externalAccountId))
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Connect GitHub and approve repository access in Moira Settings.",
      );
    return account;
  };
  const refresh = async (userId: string) => {
    if ((await connection.refreshGrants(userId, { force: true })).stale)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Refresh GitHub access in Moira Settings.");
    return requireAccount(userId);
  };
  return new LocalRepositoryAdmissionService({
    devices: getLocalDeviceService(),
    listInstallations: githubAuthority.listInstallations,
    verifyAccount: async (userId) => {
      const account = await refresh(userId);
      return { githubUserId: account.externalAccountId, owner: account.externalLogin };
    },
    verifyRepository: async (userId, repositoryId) => {
      await refresh(userId);
      const token = await connection.getAccessToken(userId);
      const before = requireAccount(userId);
      const grant = before.repositories.find(
        (repository) => repository.externalRepositoryId === repositoryId,
      );
      if (
        !grant ||
        !before.installations.some(
          (installation) => installation.externalInstallationId === grant.externalInstallationId,
        )
      )
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "Add this repository to the Moira GitHub App installation first.",
        );
      let repository: Awaited<
        ReturnType<ReturnType<typeof githubAuthority.provider>["inspectRepositoryById"]>
      >;
      try {
        repository = await githubAuthority.provider().inspectRepositoryById(token, repositoryId);
      } catch (error) {
        if (!(error instanceof GitHubCodespaceClientError)) throw error;
        throw new LocalDeviceError(
          "LOCAL_CONFLICT",
          "GitHub repository verification is unavailable; retry the same request.",
        );
      }
      const after = requireAccount(userId);
      if (
        after.id !== before.id ||
        after.credentialGeneration !== before.credentialGeneration ||
        after.externalAccountId !== before.externalAccountId ||
        !after.repositories.some(
          (entry) =>
            entry.externalRepositoryId === repositoryId && entry.fullName === grant.fullName,
        ) ||
        repository.id !== repositoryId ||
        repository.fullName.toLowerCase() !== grant.fullName.toLowerCase() ||
        repository.private !== grant.private ||
        repository.ownerId !== after.externalAccountId ||
        repository.ownerLogin.toLowerCase() !== after.externalLogin.toLowerCase()
      )
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "GitHub repository authority changed during verification.",
        );
      return {
        githubUserId: after.externalAccountId,
        owner: repository.ownerLogin,
        repositoryId,
        fullName: repository.fullName,
        private: repository.private,
        canRead: repository.canRead,
        canPush: repository.canPush,
      };
    },
  });
}
let service: LocalRepositoryAdmissionService | undefined;
export function getLocalRepositoryAdmissionService(): LocalRepositoryAdmissionService {
  return (service ??= createAdmissionService());
}
