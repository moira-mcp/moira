import { describe, expect, test } from "@jest/globals";
import { Readable } from "node:stream";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunicationOwnerScope, CommunicationOwnerSubmit } from "@mcp-moira/shared";
import {
  AgentMessageQueue,
  UserNotificationHandler,
  notificationLiveRun,
  type IDataRepository,
  type IGraphExecutionEngine,
  UserCommunicationService,
  type WorkflowExecution,
} from "@mcp-moira/workflow-engine";
import { decodeReference } from "@mcp-moira/shared/workspace-references";
import { createOwnerCommunication } from "../../../packages/workspace-service/src/owner-communication.mjs";
import { createOwnerPublications } from "../../../packages/workspace-service/src/publications.mjs";
import {
  createWorkspaceToolHandler,
  type WorkspaceSemanticServices,
} from "../../../packages/mcp-server/src/tools/workspace-tools.js";
import type { CommunicationPurposeDependencies } from "../../../packages/mcp-server/src/tools/workspace-communication.js";
import { LiveCommunicationFileOwner } from "../../../packages/web-backend/src/services/communication-file-owner.js";
import {
  jsonResponse,
  type WorkspaceClient,
} from "../../../packages/web-backend/src/services/workspace-router.js";

const resourceId = "620b1509-24ea-48d4-a73e-063fae51e166";
const requestId = "ws1-c2fe6a69-74b9-4a70-a1df-38399297d9f6";
const referenceId = `owner-file://workspace/${resourceId}/${"a".repeat(43)}`;

function fixture(statusCode: number, code: string, transportFailure = false) {
  const methods: string[] = [];
  const client: WorkspaceClient = {
    async request(_user, _resource, input) {
      methods.push(input.method);
      if (transportFailure) throw new Error("private socket failure");
      return {
        statusCode,
        headers: {},
        body: Readable.from([
          JSON.stringify({ error: { code, message: "private path /secret/file" } }),
        ]),
      };
    },
    async json(user, resource, input) {
      return jsonResponse(
        await client.request(user, resource, {
          ...input,
          body: input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body)),
        }),
      );
    },
  };
  const owner = new LiveCommunicationFileOwner({
    devices: () => {
      throw new Error("not used");
    },
    controller: () => client,
    workspace: () => client,
    authorizePublication: () => "user",
  });
  return { owner, methods };
}

describe("cloud file-owner receipt boundary", () => {
  test.each([
    "delivered",
    "refused",
    "unconfirmed",
    "malformed",
    "optional",
    "optional-failed",
    "optional-thrown",
  ] as const)(
    "a controlled workflow delivery returns its original handle for %s and public collection does not resend",
    async (status) => {
      const optional = status.startsWith("optional");
      const vendorStatus = optional ? "refused" : status === "malformed" ? "delivered" : status;
      const root = await realpath(await mkdtemp(join(tmpdir(), "notification-original-")));
      const scope = {
        kind: "controller" as const,
        userId: "user",
        deviceId: resourceId,
        deviceGeneration: 2,
        connectionId: "620b1509-24ea-48d4-a73e-063fae51e167",
      };
      const publications = await createOwnerPublications({
        stateRoot: root,
        scope: { ...scope, publicOrigin: "https://moira.example" },
        environmentIdentity: "controlled-controller",
        withCommitLock: (work) => work(),
      });
      const bodies: Buffer[] = [];
      const delivery = await createOwnerCommunication({
        stateRoot: root,
        scope,
        publications,
        renderProgress: async () => Buffer.from("original bytes"),
        transport: {
          prepare: async () => ({
            channels: [
              { channelId: "telegram", provider: "telegram", authorityDigest: "a".repeat(64) },
            ],
          }),
          send: async (_input, source) => {
            const chunks: Buffer[] = [];
            for await (const bytes of source) chunks.push(Buffer.from(bytes));
            bodies.push(Buffer.concat(chunks));
            return { status: vendorStatus };
          },
        },
      });
      let submitted: CommunicationOwnerSubmit | undefined;
      const client: WorkspaceClient = {
        request: async () => {
          throw new Error("Unexpected raw stream request");
        },
        json: async (_user, _id, input) => {
          if (input.method === "POST") {
            submitted = input.body as CommunicationOwnerSubmit;
            const receipt = await delivery.submit(submitted);
            if (status === "refused" || status === "unconfirmed")
              throw new Error("Original applied reply lost");
            return status === "malformed"
              ? { ...receipt, state: "invalid-response-state" }
              : receipt;
          }
          return delivery.inspect(input.path.split("/").at(-1)!);
        },
      };
      const owner = new LiveCommunicationFileOwner({
        devices: () =>
          ({
            listRegistered: () => ({ devices: [{ ...scope, status: "active" }] }),
            getDeviceIdentity: () => ({ ...scope, status: "active" }),
          }) as never,
        controller: () => client,
        workspace: () => client,
        authorizePublication: () => "user",
      });
      const run: WorkflowExecution = {
        executionId: "controlled-execution",
        workflowId: "controlled-workflow",
        userId: "user",
        revision: 1,
        status: "running",
        currentNodeId: "notify",
        waitingForInputNodeId: null,
        createdAt: 1,
        updatedAt: 1,
        globalContext: {
          executionId: "controlled-execution",
          workflowId: "controlled-workflow",
          userId: "user",
          variables: {},
          nodeStates: {},
        },
        visits: [],
      };
      const repository = {
        getExecution: async () => run,
        getWorkflow: async () => ({ metadata: { name: "Controlled workflow" } }),
        getWorkflowGraph: async () => ({
          metadata: { name: "Controlled workflow", version: "1.0.0", description: "test" },
          progress: { nodes: [{ id: "p", label: "Progress" }] },
          nodes: [],
        }),
      } as unknown as IDataRepository;
      const communication = new UserCommunicationService([]);
      communication.deliver = async () => {
        if (status === "optional-thrown") throw new Error("Text delivery unavailable");
        return {
          status: status === "optional-failed" ? "all_failed" : "delivered",
          configuredChannels: 1,
          eligibleChannels: 1,
          deliveredChannels: status === "optional-failed" ? 0 : 1,
          channels: [],
        };
      };
      const handler = new UserNotificationHandler(communication, owner);
      try {
        const result = await handler.execute(
          {
            id: "notify",
            type: "user-notification",
            message: "Original notification",
            ...(optional
              ? { attachProgressImage: true }
              : {
                  attachment: {
                    data: Buffer.from("original bytes").toString("base64"),
                    encoding: "base64",
                    filename: "report.bin",
                    mimeType: "application/octet-stream",
                    kind: "document",
                  },
                }),
            connections: { default: "end" },
          },
          {
            userId: "user",
            executionId: run.executionId,
            workflowId: run.workflowId,
            variables: {},
            nodeStates: {},
          },
          new AgentMessageQueue(),
          repository,
          {} as IGraphExecutionEngine,
          undefined,
          undefined,
          notificationLiveRun({ execution: run }, [], {}, "notify"),
        );
        const reference = result.data?.operation;
        expect(result.data).toHaveProperty("operation", expect.any(String));
        expect(result.data).not.toHaveProperty("communicationRequestId");
        expect(result.data).not.toHaveProperty("device_id");
        expect(result.data).not.toHaveProperty("codespace_id");
        const original = decodeReference(String(reference), "operation");
        expect(original).toMatchObject({
          owner: { kind: "controller", deviceId: scope.deviceId, connectionId: scope.connectionId },
          requestId: submitted!.requestId,
          kind: "delivery",
        });
        const journal = join(root, "communication", original.requestId + ".json");
        const before = await readFile(journal);
        const unexpected = async (): Promise<never> => {
          throw new Error("Unexpected effect or workspace selection");
        };
        const services: WorkspaceSemanticServices = {
          invoke: unexpected,
          resolveWorkspace: unexpected,
          resolveWorkspaceResource: unexpected,
          resolveOwner: async () => ({
            controller: client,
            deviceId: scope.deviceId,
            owner: {
              kind: "controller",
              deviceId: scope.deviceId,
              connectionId: scope.connectionId,
            },
          }),
        };
        const execute = createWorkspaceToolHandler(services, {
          owner,
          communicationService: communication,
          repository: {} as CommunicationPurposeDependencies["repository"],
          audit: async () => {},
        });
        const collected = await execute("operation_get", { reference }, "user");
        expect(collected.structuredContent).toMatchObject({
          operation: reference,
          state: status === "unconfirmed" ? "unconfirmed" : "completed",
          outcome: { ok: status === "delivered" || status === "malformed" },
        });
        expect((await delivery.inspect(original.requestId)).state).toBe("completed");
        expect(collected.structuredContent!.state).toBe(
          (await delivery.find()).operations[0].state,
        );
        expect(await readFile(journal)).toEqual(before);
        expect(bodies).toEqual([Buffer.from("original bytes")]);
      } finally {
        await delivery.close();
        await publications.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  test("selection pins a registered offline owner and refuses a changed pairing identity", async () => {
    const observed = {
      deviceId: resourceId,
      status: "active",
      deviceGeneration: 2,
      connectionId: "620b1509-24ea-48d4-a73e-063fae51e167",
      owner: { state: "unavailable" },
    };
    let current = { ...observed };
    const owner = new LiveCommunicationFileOwner({
      devices: () =>
        ({
          listRegistered: () => ({ devices: [observed] }),
          getDeviceIdentity: () => current,
        }) as never,
      controller: () => {
        throw new Error("selection cannot dispatch");
      },
      workspace: () => {
        throw new Error("selection cannot dispatch");
      },
      authorizePublication: () => "user",
    });
    expect(await owner.select("user", resourceId)).toEqual({
      kind: "controller",
      userId: "user",
      deviceId: resourceId,
      deviceGeneration: 2,
      connectionId: observed.connectionId,
    });
    current = { ...current, deviceGeneration: 3 };
    await expect(owner.select("user", resourceId)).rejects.toMatchObject({
      code: "COMMUNICATION_OWNER_UNAVAILABLE",
    });
    current = {
      ...observed,
      connectionId: "620b1509-24ea-48d4-a73e-063fae51e168",
    };
    await expect(owner.select("user", resourceId)).rejects.toMatchObject({
      code: "COMMUNICATION_OWNER_UNAVAILABLE",
    });
  });

  test("implicit selection never substitutes an online owner for an ambiguous registered pairing", async () => {
    const registered = [
      {
        deviceId: resourceId,
        status: "active",
        deviceGeneration: 2,
        connectionId: "620b1509-24ea-48d4-a73e-063fae51e167",
        owner: { state: "unavailable" },
      },
      {
        deviceId: "620b1509-24ea-48d4-a73e-063fae51e169",
        status: "active",
        deviceGeneration: 1,
        connectionId: "620b1509-24ea-48d4-a73e-063fae51e170",
        owner: { state: "available" },
      },
    ];
    const owner = new LiveCommunicationFileOwner({
      devices: () =>
        ({
          listRegistered: () => ({ devices: registered }),
          getDeviceIdentity: (_user: string, id: string) =>
            registered.find((device) => device.deviceId === id),
        }) as never,
      controller: () => {
        throw new Error("selection cannot dispatch");
      },
      workspace: () => {
        throw new Error("selection cannot dispatch");
      },
      authorizePublication: () => "user",
    });
    await expect(owner.select("user")).rejects.toMatchObject({
      code: "COMMUNICATION_OWNER_UNAVAILABLE",
    });
    expect(await owner.select("user", resourceId)).toMatchObject({
      deviceId: resourceId,
      deviceGeneration: 2,
      connectionId: registered[0]!.connectionId,
    });
  });

  test("submission preserves the pinned scope when routing observes a later pairing", async () => {
    const expectedScope: Extract<CommunicationOwnerScope, { kind: "controller" }> = {
      kind: "controller",
      userId: "user",
      deviceId: resourceId,
      deviceGeneration: 2,
      connectionId: "620b1509-24ea-48d4-a73e-063fae51e167",
    };
    const current = {
      ...expectedScope,
      deviceGeneration: 3,
      connectionId: "620b1509-24ea-48d4-a73e-063fae51e168",
      status: "active",
      owner: { state: "available" },
    };
    const submitted: unknown[] = [];
    const client: WorkspaceClient = {
      async request() {
        throw new Error("not used");
      },
      async json(_user, _id, input) {
        submitted.push(input.body);
        return { requestId, state: "completed" };
      },
    };
    const owner = new LiveCommunicationFileOwner({
      devices: () =>
        ({
          listRegistered: () => ({ devices: [current] }),
          getDeviceIdentity: () => current,
        }) as never,
      controller: () => client,
      workspace: () => client,
      authorizePublication: () => "user",
    });
    const input: CommunicationOwnerSubmit = {
      action: "publish",
      requestId,
      expectedScope,
      source: { type: "materialize-text-set", files: [{ path: "note.md", content: "text" }] },
    };
    await owner.submit("user", input, resourceId);
    expect(submitted).toEqual([input]);
    expect((submitted[0] as CommunicationOwnerSubmit).expectedScope).toEqual(expectedScope);
  });

  test("preserves a parsed HTTP source refusal without claiming the reply was lost", async () => {
    const f = fixture(422, "SOURCE_REFUSED");
    const receipt = await f.owner.submit("user", {
      action: "deliver",
      requestId,
      source: { type: "publication", referenceId },
      kind: "document",
      text: "",
    });
    expect(receipt).toMatchObject({
      requestId,
      state: "completed",
      codespace_id: resourceId,
      outcome: { ok: false, error: { code: "SOURCE_REFUSED" } },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/secret|reply.*lost|OUTCOME_UNCONFIRMED/);
    expect(f.methods).toEqual(["POST"]);
  });

  test("transport loss retains original identity and collection never repeats delivery", async () => {
    const f = fixture(503, "UNUSED", true);
    const input = {
      action: "deliver" as const,
      requestId,
      source: { type: "publication" as const, referenceId },
      kind: "document" as const,
      text: "",
    };
    expect(await f.owner.submit("user", input)).toMatchObject({
      requestId,
      state: "unconfirmed",
      codespace_id: resourceId,
    });
    expect(await f.owner.collect("user", requestId, { resourceId })).toMatchObject({
      requestId,
      state: "unconfirmed",
      codespace_id: resourceId,
    });
    expect(f.methods).toEqual(["POST", "GET"]);
  });

  test("current collection refusal cannot declare the prior original operation complete", async () => {
    const f = fixture(403, "COMMUNICATION_SCOPE_REFUSED");
    expect(await f.owner.collect("user", requestId, { resourceId })).toMatchObject({
      requestId,
      state: "unconfirmed",
      outcome: { ok: false, error: { code: "COMMUNICATION_SCOPE_REFUSED" } },
    });
    expect(f.methods).toEqual(["GET"]);
  });

  test.each([
    "CODESPACE_PROVIDER_UNAVAILABLE",
    "CODESPACE_AUTHORIZATION_REQUIRED",
    "CODESPACE_GENERATION_CONFLICT",
    "CODESPACE_PROVIDER_DISABLED",
    "CODESPACE_RESOURCE_INVALID",
    "CODESPACE_NOT_FOUND",
  ])("keeps current dispatch refusal %s without inventing the historical outcome", async (code) => {
    const f = fixture(503, code);
    const submitted = await f.owner.submit("user", {
      action: "deliver",
      requestId,
      source: { type: "publication", referenceId },
      kind: "document",
      text: "",
    });
    expect(submitted).toMatchObject({
      requestId,
      state: "unconfirmed",
      codespace_id: resourceId,
      outcome: { ok: false, error: { code } },
    });
    expect(submitted).toHaveProperty(
      "outcome.error.message",
      expect.stringContaining("before dispatch"),
    );
    const original = await f.owner.collect("user", requestId, { resourceId });
    expect(original).toMatchObject({
      requestId,
      state: "unconfirmed",
      outcome: { ok: false, error: { code } },
    });
    expect(original).toHaveProperty(
      "outcome.error.message",
      expect.stringContaining("original outcome remains unconfirmed"),
    );
    expect(JSON.stringify([submitted, original])).not.toMatch(/secret|no delivery was admitted/);
    expect(f.methods).toEqual(["POST", "GET"]);
  });
});
