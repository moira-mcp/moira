import { RepositoryCreationRepository, getSqliteInstance } from "@mcp-moira/shared";
import { getLocalRepositoryAdmissionService } from "./local-repository-admission-factory.js";
import { createLocalGitHubRepositoryAuthority } from "./local-github-repository-authority.js";
import { LocalPrivateRepositoryCreationService } from "./local-private-repository-creation.js";
import { getLocalDeviceService } from "./codespace-services.js";

let service: LocalPrivateRepositoryCreationService | undefined;
export function getLocalPrivateRepositoryCreationService(): LocalPrivateRepositoryCreationService {
  return (service ??= new LocalPrivateRepositoryCreationService({
    repository: new RepositoryCreationRepository(getSqliteInstance(), (userId, deviceId) =>
      getLocalDeviceService().getActiveDevice(userId, deviceId),
    ),
    admission: getLocalRepositoryAdmissionService(),
    ...createLocalGitHubRepositoryAuthority(),
  }));
}
