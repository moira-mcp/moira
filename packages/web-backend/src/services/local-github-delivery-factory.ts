import { CodespaceConnectionRepository, getSqliteInstance } from "@mcp-moira/shared";
import { getCodespaceConnectionService, getLocalDeviceService } from "./codespace-services.js";
import { LocalGitHubDelivery } from "./local-github-delivery.js";

function createLocalGitHubDeliveryFacade() {
  const devices = getLocalDeviceService();
  const delivery = new LocalGitHubDelivery({
    connection: getCodespaceConnectionService(),
    connections: new CodespaceConnectionRepository(getSqliteInstance()),
    authorize: (auth, resourceId, generation, action) =>
      devices.authorizeGitHubOperation(auth, resourceId, generation, action),
  });
  return {
    delivery,
    createOwnedPullRequest(userId: string, resourceId: string, input: unknown) {
      const binding = devices.authorizeOwnedGitHubOperation(userId, resourceId, "pull_request");
      return delivery.createPullRequest(
        binding.auth,
        resourceId,
        binding.resourceGeneration,
        input,
      );
    },
    getOwnedPullRequest(userId: string, resourceId: string, number: number) {
      const binding = devices.authorizeOwnedGitHubOperation(userId, resourceId, "fetch");
      return delivery.getPullRequest(binding.auth, resourceId, binding.resourceGeneration, number);
    },
    findOwnedPullRequests(userId: string, resourceId: string, input: unknown) {
      const binding = devices.authorizeOwnedGitHubOperation(userId, resourceId, "fetch");
      return delivery.findPullRequests(binding.auth, resourceId, binding.resourceGeneration, input);
    },
  };
}

let facade: ReturnType<typeof createLocalGitHubDeliveryFacade> | undefined;

/** The web and MCP processes compose the same repository-bound authority privately. */
export function getLocalGitHubDeliveryService() {
  return (facade ??= createLocalGitHubDeliveryFacade());
}
