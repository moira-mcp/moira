import { CodespaceConnectionRepository, getSqliteInstance } from "@mcp-moira/shared";
import { getCodespaceConnectionService, getLocalDeviceService } from "./codespace-services.js";
import { LocalGitIdentity } from "./local-git-identity.js";

let identity: LocalGitIdentity | undefined;
export function getLocalGitIdentityService() {
  return (identity ??= new LocalGitIdentity({
    connection: getCodespaceConnectionService(),
    connections: new CodespaceConnectionRepository(getSqliteInstance()),
    authorize: (auth, resourceId, generation) =>
      getLocalDeviceService().authorizeGitHubOperation(auth, resourceId, generation, "fetch"),
  }));
}
