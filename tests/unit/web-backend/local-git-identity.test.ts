import { describe, expect, it, jest } from "@jest/globals";
import {
  LocalDeviceError,
  type CodespaceConnectionSnapshot,
  type LocalDeviceAuth,
} from "@mcp-moira/shared";
import { LocalGitIdentity } from "../../../packages/web-backend/src/services/local-git-identity.js";

const auth: LocalDeviceAuth = {
  userId: "owner",
  deviceId: "device",
  deviceGeneration: 1,
  connectionId: "local",
};
function fixture() {
  let allowed = true;
  const connection = {
    id: "github",
    userId: "owner",
    provider: "github-codespaces",
    externalAccountId: "123",
    externalLogin: "owner",
    status: "connected",
    credentialGeneration: 1,
    lastErrorCode: null,
    installations: [{ externalInstallationId: "99", repositorySelection: "selected" }],
    repositories: [
      {
        externalInstallationId: "99",
        externalRepositoryId: "456",
        fullName: "owner/private",
        private: true,
      },
    ],
  } as CodespaceConnectionSnapshot;
  const refresh = jest.fn(async () => ({ refreshed: true, stale: false }));
  const identity = new LocalGitIdentity({
    connection: { refreshGrants: refresh },
    connections: { getConnection: () => connection },
    authorize: (who, resource, generation) => {
      if (!allowed || who.userId !== "owner" || resource !== "resource" || generation !== 3)
        throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Denied");
      return {
        id: "repo",
        fullName: "owner/private",
        private: true,
        allowPush: false,
        allowPullRequests: false,
        allowDelete: false,
      };
    },
  });
  return {
    identity,
    connection,
    refresh,
    revoke: () => {
      allowed = false;
    },
  };
}
describe("verified Local Git author metadata", () => {
  it("returns the verified GitHub author without requiring an access-token operation", async () => {
    const f = fixture();
    expect(await f.identity.identity(auth, "resource", 3)).toEqual({
      name: "owner",
      email: "123+owner@users.noreply.github.com",
    });
  });
  it("rechecks Local authority after asynchronous grant refresh", async () => {
    const f = fixture();
    f.refresh.mockImplementation(async () => {
      f.revoke();
      return { refreshed: true, stale: false };
    });
    await expect(f.identity.identity(auth, "resource", 3)).rejects.toBeInstanceOf(LocalDeviceError);
  });
  it.each(["repository", "installation", "account", "stale"])(
    "refuses unverified %s metadata",
    async (kind) => {
      const f = fixture();
      if (kind === "repository") f.connection.repositories = [];
      if (kind === "installation") f.connection.installations = [];
      if (kind === "account") f.connection.externalAccountId = "unverified";
      if (kind === "stale") f.refresh.mockResolvedValue({ refreshed: false, stale: true });
      await expect(f.identity.identity(auth, "resource", 3)).rejects.toBeInstanceOf(
        LocalDeviceError,
      );
    },
  );
});
