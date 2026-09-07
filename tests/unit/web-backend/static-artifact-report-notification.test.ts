import { describe, expect, test, jest } from "@jest/globals";
import type {
  CommunicationChannelAdapter,
  IDataRepository,
  PortableCommunicationMessage,
  UserCommunicationRequest,
  UserCommunicationResult,
} from "@mcp-moira/workflow-engine";
import { CommunicationChannelRegistry, UserCommunicationService } from "@mcp-moira/workflow-engine";
import {
  notifyAdminsOfReport,
  type ArtifactReportNotificationDependencies,
} from "../../../packages/web-backend/src/routes/static-artifacts.js";

function result(status: UserCommunicationResult["status"]): UserCommunicationResult {
  const delivered = status === "delivered" || status === "partial";
  return {
    status,
    configuredChannels: status === "no_configured_channels" ? 0 : 1,
    deliveredChannels: delivered ? 1 : 0,
    channels:
      status === "no_configured_channels"
        ? [{ channelId: "extension-only.notifications", status: "not_configured" }]
        : [
            {
              channelId: "extension-only.notifications",
              status: delivered ? "delivered" : "failed",
            },
          ],
  };
}

function dependencies(
  adminIds: string[],
  deliver: (
    request: UserCommunicationRequest,
    repository: IDataRepository,
  ) => Promise<UserCommunicationResult>,
  repository: IDataRepository = {} as IDataRepository,
) {
  const info = jest.fn();
  const warn = jest.fn();
  const value: ArtifactReportNotificationDependencies = {
    communicationService: { deliver },
    createRepository: () => repository,
    getAdminUserIds: async () => adminIds,
    getOwnerId: async () => "artifact-owner",
    getArtifactUrl: (uuid) => `https://${uuid}.static.example.test/`,
    getBaseUrl: () => "https://example.test",
    logger: { info, warn },
  };
  return { value, info, warn, repository };
}

describe("artifact report administrator notifications", () => {
  test("routes each administrator through portable configured channels", async () => {
    const configurationUsers: string[] = [];
    const delivered: PortableCommunicationMessage[] = [];
    const adapter: CommunicationChannelAdapter = {
      id: "extension-only.notifications",
      provider: "extension-only.notifications",
      capabilities: { text: true, image: false, document: false, trusted: false },
      metadata: {
        title: "Extension-only notifications",
        origin: "extension",
        extensionName: "extension-only",
        settingKeys: ["extension-only.ready"],
      },
      async isConfigured(configuration) {
        return (await configuration.get("extension-only.ready")) === true;
      },
      async deliver(message) {
        delivered.push(message);
      },
    };
    const repository = {
      async getSetting<T>(userId: string, key: string): Promise<T | null> {
        configurationUsers.push(userId);
        return (key === "extension-only.ready" ? true : null) as T | null;
      },
    } as IDataRepository;
    const service = new UserCommunicationService(new CommunicationChannelRegistry([adapter]));
    const fixture = dependencies(
      ["extension-admin", "second-admin"],
      (request, selectedRepository) => service.deliver(request, selectedRepository),
      repository,
    );

    await notifyAdminsOfReport("artifact-uuid", 3, fixture.value);

    expect(configurationUsers).toEqual(["extension-admin", "second-admin"]);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({
      format: "markdown",
      purpose: "notification",
    });
    expect(delivered[0].text).toContain("Artifact reported");
    expect(delivered[0].text).toContain("artifact-uuid");
    expect(delivered[0].text).toContain("artifact-owner");
    expect(delivered[0].text).toContain("Reports: 3");
    expect(delivered[0].text).toContain("https://artifact-uuid.static.example.test/");
    expect(delivered[0].text).toContain("https://example.test/admin/artifacts/reported");
  });

  test("isolates unavailable, failed, and throwing administrator attempts without leaking details", async () => {
    const attempted: string[] = [];
    const outcomes: Record<string, UserCommunicationResult["status"] | "throw"> = {
      unavailable: "no_configured_channels",
      failed: "all_failed",
      throwing: "throw",
      delivered: "delivered",
    };
    const fixture = dependencies(Object.keys(outcomes), async (request) => {
      attempted.push(request.userId);
      const outcome = outcomes[request.userId];
      if (outcome === "throw") {
        throw new Error("provider secret for private destination");
      }
      return result(outcome);
    });

    await expect(notifyAdminsOfReport("artifact-uuid", 1, fixture.value)).resolves.toBeUndefined();

    expect(attempted).toEqual(["unavailable", "failed", "throwing", "delivered"]);
    expect(fixture.warn).toHaveBeenCalledWith(
      "Artifact report admin notification failed (non-blocking)",
      { uuid: "artifact-uuid", adminId: "throwing", status: "failed" },
    );
    const logged = JSON.stringify([...fixture.info.mock.calls, ...fixture.warn.mock.calls]);
    expect(logged).not.toContain("provider secret");
    expect(logged).not.toContain("private destination");
    expect(logged).not.toContain("Artifact reported");
    expect(fixture.info).toHaveBeenLastCalledWith("Artifact report admin notifications completed", {
      uuid: "artifact-uuid",
      admins: 4,
      delivered: 1,
      unavailable: 1,
      failed: 2,
    });
  });
});
