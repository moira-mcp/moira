import { expect, test } from "@jest/globals";
import {
  CommunicationChannelOwnerUnavailableError,
  type CommunicationFileOwner,
} from "@mcp-moira/workflow-engine";
import { createManageCommunication } from "../../../packages/mcp-server/src/tools/manage-communication.js";
import { runWithMCPContext } from "../../../packages/mcp-server/src/core/request-context.js";

const requestId = "ws1-3669eb26-6af3-4e9e-a722-dcc43efa1792";
const deviceId = "620b1509-24ea-48d4-a73e-063fae51e166";

test.each(["operation", "deliver-file"] as const)(
  "unavailable current owner on %s leaves the original delivery outcome unconfirmed",
  async (action) => {
    // The handler cannot observe the original receipt through this unavailable route.
    // Neither collection nor repeated submission can establish its historical absence.
    const owner: CommunicationFileOwner = {
      async select() {
        throw new CommunicationChannelOwnerUnavailableError();
      },
      async collect() {
        throw new CommunicationChannelOwnerUnavailableError();
      },
      async submit() {
        throw new CommunicationChannelOwnerUnavailableError();
      },
      async openPublication() {
        throw new CommunicationChannelOwnerUnavailableError();
      },
    };
    const manage = createManageCommunication({
      owner,
      communicationService: {
        async deliver() {
          throw new Error("A file receipt must not dispatch ordinary text");
        },
      },
      repository: {} as never,
      audit: async () => {},
    });
    const response = await runWithMCPContext({ userId: "owner" }, () =>
      manage({
        action,
        request_id: requestId,
        device_id: deviceId,
        ...(action === "deliver-file"
          ? { referenceId: `owner-file://controller/${deviceId}/${"a".repeat(43)}` }
          : {}),
      }),
    );
    expect(response.isError).toBe(true);
    const reply = JSON.parse((response.content[0] as { text: string }).text);
    expect(reply).toMatchObject({
      status: "unavailable",
      request_id: requestId,
      device_id: deviceId,
      error: {
        code: "COMMUNICATION_OWNER_UNAVAILABLE",
        message: expect.stringContaining("original delivery outcome remains unconfirmed"),
      },
    });
    expect(reply.error.message).not.toMatch(/no delivery was admitted|never (?:ran|delivered)/i);
  },
);
