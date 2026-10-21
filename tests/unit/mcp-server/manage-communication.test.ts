import { expect, test } from "@jest/globals";
import {
  CommunicationChannelOwnerUnavailableError,
  type CommunicationFileOwner,
} from "@mcp-moira/workflow-engine";
import { encodeReference, decodeReference } from "@mcp-moira/shared/workspace-references";
import {
  createWorkspaceToolHandler,
  type WorkspaceSemanticServices,
} from "../../../packages/mcp-server/src/tools/workspace-tools.js";
import type { CommunicationPurposeDependencies } from "../../../packages/mcp-server/src/tools/workspace-communication.js";
const deviceId = "620b1509-24ea-48d4-a73e-063fae51e166",
  connectionId = "620b1509-24ea-48d4-a73e-063fae51e167";
const ownerSelector = { kind: "controller" as const, deviceId, connectionId };
function fixture(available = true) {
  let submissions = 0,
    collections = 0;
  const owner: CommunicationFileOwner = {
    async select() {
      if (!available) throw new CommunicationChannelOwnerUnavailableError();
      return { kind: "controller", userId: "owner", deviceId, connectionId, deviceGeneration: 1 };
    },
    async submit() {
      submissions++;
      throw new CommunicationChannelOwnerUnavailableError();
    },
    async collect() {
      collections++;
      throw new CommunicationChannelOwnerUnavailableError();
    },
    async openPublication() {
      throw new Error("Cloud file acquisition is forbidden");
    },
  };
  const services: WorkspaceSemanticServices = {
    resolveOwner: async () => ({
      controller: {
        json: async () => {
          throw new Error("unexpected");
        },
      },
      deviceId,
      owner: ownerSelector,
    }),
    resolveWorkspace: async () => {
      throw new Error("unexpected workspace");
    },
    resolveWorkspaceResource: async () => {
      throw new Error("unexpected workspace");
    },
    invoke: async () => {
      throw new Error("unexpected dispatch");
    },
  };
  const dependencies: CommunicationPurposeDependencies = {
    owner,
    communicationService: {
      deliver: async () => {
        throw new Error("not text");
      },
      deliverChannel: async () => {
        throw new Error("not text");
      },
    },
    repository: {} as never,
    audit: async () => {},
  };
  return {
    execute: createWorkspaceToolHandler(services, dependencies),
    submissions: () => submissions,
    collections: () => collections,
    dependencies,
  };
}
test("an unavailable selected controller refuses before a new delivery identity is admitted", async () => {
  const value = fixture(false);
  const result = await value.execute(
    "communication_deliver",
    {
      file: { file_id: "file_Example", download_url: "https://files.oaiusercontent.com/private" },
      kind: "document",
    },
    "owner",
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: "COMMUNICATION_OWNER_UNAVAILABLE" },
  });
  expect(result.structuredContent).not.toHaveProperty("operation");
  expect(value.submissions()).toBe(0);
  expect(JSON.stringify(result)).not.toContain("private");
});
test("lost delivery reply keeps one internally minted operation and collection cannot submit again", async () => {
  const value = fixture();
  const result = await value.execute(
    "communication_deliver_publication",
    { publication: `owner-file://controller/${deviceId}/${"a".repeat(43)}`, kind: "document" },
    "owner",
  );
  const operation = String(result.structuredContent!.operation);
  expect(decodeReference(operation, "operation")).toMatchObject({
    owner: ownerSelector,
    kind: "delivery",
    requestId: expect.stringMatching(/^ws1-/),
  });
  expect(value.submissions()).toBe(1);
  const collected = await value.execute("operation_get", { reference: operation }, "owner");
  expect(collected.isError).toBe(true);
  expect(value.submissions()).toBe(1);
  expect(value.collections()).toBe(1);
  expect(JSON.stringify(collected)).not.toMatch(
    /never delivered|no delivery was admitted|state.*absent/,
  );
});
test("a changed explicit controller connection cannot silently select a new owner", async () => {
  const value = fixture();
  const changed = encodeReference("controller", { deviceId, connectionId: deviceId });
  const result = await value.execute(
    "communication_deliver",
    {
      owner: changed,
      file: { file_id: "file_Example", download_url: "https://files.oaiusercontent.com/private" },
      kind: "document",
    },
    "owner",
  );
  expect(result.structuredContent).toMatchObject({ error: { code: "LOCAL_UNAUTHORIZED" } });
  expect(value.submissions()).toBe(0);
});
test("ordinary selected-channel delivery reuses configured service authority without choosing recipients", async () => {
  const value = fixture();
  let called: unknown;
  value.dependencies.communicationService.deliverChannel = async (channel, request) => {
    called = { channel, request };
    return {
      status: "delivered",
      configuredChannels: 1,
      eligibleChannels: 1,
      deliveredChannels: 1,
      channels: [],
    };
  };
  const result = await value.execute(
    "communication_send",
    { message: "report ready", channel: "telegram", silent: true },
    "owner",
  );
  expect(result.isError).not.toBe(true);
  expect(called).toEqual({
    channel: "telegram",
    request: {
      userId: "owner",
      text: "report ready",
      purpose: "notification",
      silent: true,
      format: undefined,
    },
  });
  expect(value.submissions()).toBe(0);
});
