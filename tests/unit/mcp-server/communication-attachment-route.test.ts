import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CodespaceTransferRepository,
  CodespaceTransferService,
  evaluateCodespaceResourcePolicy,
} from "@mcp-moira/shared";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it } from "@jest/globals";
import { CommunicationAttachmentGrantService } from "../../../packages/shared/src/services/communication-attachment-grant-service.js";
import type { logAuditEvent } from "../../../packages/shared/src/logging/audit-logger.js";
import {
  type CommunicationChannelAdapter,
  UserCommunicationService,
} from "../../../packages/workflow-engine/src/services/user-communication.js";
import type { DatabaseRepository } from "../../../packages/workflow-engine/src/storage/database-repository.js";
import {
  createCommunicationAttachmentHandler,
  type CommunicationAttachmentRouteDependencies,
} from "../../../packages/mcp-server/src/communication-attachment-route.js";
import {
  CommunicationAttachmentInflightLimiter,
  MAX_ATTACHMENT_INFLIGHT_BYTES_PER_USER,
} from "../../../packages/mcp-server/src/communication-attachment-inflight.js";
import { createManageCommunication } from "../../../packages/mcp-server/src/tools/manage-communication.js";
import { runWithMCPContext } from "../../../packages/mcp-server/src/core/request-context.js";

function createGrantTable(db: Database.Database): void {
  migrate(drizzle(db), {
    migrationsFolder: resolve(process.cwd(), "packages/web-backend/drizzle"),
  });
  db.exec(
    "INSERT INTO user (id,email,handle,createdAt,updatedAt) VALUES ('user-a','a@example.test','user-a','now','now'),('user-b','b@example.test','user-b','now','now')",
  );
}

/** The text of a tool result's first content block, which these assertions always read. */
function firstText(result: { content: Array<{ type: string }> }): string {
  const [block] = result.content;
  if (!block || block.type !== "text") {
    throw new Error(`expected a text content block, got ${block?.type ?? "nothing"}`);
  }
  return (block as { type: "text"; text: string }).text;
}

interface ObservedDelivery {
  text: string;
  bytes: Buffer;
}

function configuredAdapter(
  deliveries: ObservedDelivery[],
  fail = false,
): CommunicationChannelAdapter {
  return {
    id: "test-channel",
    provider: "test-provider",
    capabilities: {
      text: true,
      image: true,
      document: true,
      trusted: false,
      streamingAttachments: true,
    },
    metadata: {
      title: "Test channel",
      origin: "extension",
      extensionName: "test",
      settingKeys: [],
    },
    async isConfigured() {
      return true;
    },
    async deliver(message) {
      const chunks: Buffer[] = [];
      if (message.attachment?.source) {
        for await (const bytes of await message.attachment.source.open())
          chunks.push(Buffer.from(bytes));
      } else chunks.push(Buffer.from(message.attachment?.bytes ?? []));
      deliveries.push({
        text: message.text,
        bytes: Buffer.concat(chunks),
      });
      if (fail) throw new Error("ambiguous_provider_failure");
    },
  };
}

const repository = {
  async getSetting() {
    return "configured";
  },
} as unknown as DatabaseRepository;

interface RawResult {
  status: number;
  body: unknown;
  reads: number;
}

describe("communication delivery boundaries", () => {
  const databases: Database.Database[] = [];
  const roots: string[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function transfers(db: Database.Database) {
    const root = mkdtempSync(join(tmpdir(), "moira-communication-transfer-"));
    roots.push(root);
    return new CodespaceTransferService({
      repository: new CodespaceTransferRepository(db),
      root,
      policy: () =>
        evaluateCodespaceResourcePolicy((name) =>
          name === "CODESPACE_CODESPACES_ENABLED" ? "true" : undefined,
        ),
      now: () => 1_800_000_000_000,
    });
  }

  function harness(failProvider = false) {
    const db = new Database(":memory:");
    databases.push(db);
    createGrantTable(db);
    const grantService = new CommunicationAttachmentGrantService(db, () => 1_800_000_000_000);
    const inflight = new CommunicationAttachmentInflightLimiter();
    const deliveries: ObservedDelivery[] = [];
    const communicationService = new UserCommunicationService([
      configuredAdapter(deliveries, failProvider),
    ]);
    const dependencies: CommunicationAttachmentRouteDependencies = {
      async authenticate() {
        return { identity: { userId: "user-a" } };
      },
      grantService,
      inflight,
      communicationService,
      transfers: transfers(db),
      createRepository: () => repository,
      audit: (async () => {}) as typeof logAuditEvent,
      logger: { error() {} },
    };
    const handler = createCommunicationAttachmentHandler(dependencies);

    const mint = () =>
      grantService.create({
        userId: "user-a",
        message: "Report",
        kind: "document",
        filename: "report.txt",
        mimeType: "text/plain",
        declaredSize: 4,
      });

    const invoke = async (
      grant: string,
      headers: Record<string, string>,
      chunks: Buffer[],
    ): Promise<RawResult> => {
      let reads = 0;
      const source = Readable.from(
        (async function* () {
          for (const chunk of chunks) {
            reads += 1;
            yield chunk;
          }
        })(),
      ) as Request;
      source.get = ((name: string) => headers[name.toLowerCase()]) as Request["get"];
      const result: RawResult = { status: 200, body: undefined, reads: 0 };
      // Only the three members the route touches; `response` is referred to by name inside the
      // methods because `this` on an object literal is not the double's own type.
      const response = {
        headersSent: false,
        status(code: number) {
          result.status = code;
          return this;
        },
        json(body: unknown) {
          result.body = body;
          response.headersSent = true;
          return this;
        },
      } as unknown as Response;
      headers["x-moira-communication-grant"] = grant;
      await handler(source, response, () => {});
      result.reads = reads;
      return result;
    };

    const validHeaders = {
      "content-length": "4",
      "content-type": "text/plain",
    };
    return { deliveries, grantService, inflight, mint, invoke, validHeaders };
  }

  it("delivers authenticated MCP text through one configured common-service adapter", async () => {
    const db = new Database(":memory:");
    databases.push(db);
    createGrantTable(db);
    const deliveries: ObservedDelivery[] = [];
    const handler = createManageCommunication({
      communicationService: new UserCommunicationService([configuredAdapter(deliveries)]),
      repository,
      grantService: new CommunicationAttachmentGrantService(db),
      baseUrl: "https://example.invalid",
      audit: async () => {},
      transfers: transfers(db),
    });

    const result = await runWithMCPContext({ userId: "user-a" }, () =>
      handler({ action: "send", message: "Configured delivery" }),
    );
    expect(JSON.parse(firstText(result))).toEqual(
      expect.objectContaining({ status: "delivered", deliveredChannels: 1 }),
    );
    expect(deliveries).toEqual([{ text: "Configured delivery", bytes: Buffer.alloc(0) }]);

    const grantResult = await runWithMCPContext({ userId: "user-a" }, () =>
      handler({
        action: "attachment-token",
        message: "Report",
        kind: "document",
        filename: "report.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
      }),
    );
    expect(JSON.parse(firstText(grantResult))).toEqual(
      expect.objectContaining({
        requiredHeaders: expect.objectContaining({
          Authorization: "Bearer <valid MCP credential for the same user>",
        }),
      }),
    );
  });

  it("races one grant into one provider attempt with exact bytes", async () => {
    const { mint, invoke, validHeaders, deliveries } = harness();
    const grant = mint();
    const results = await Promise.all([
      invoke(grant.grant, { ...validHeaders }, [Buffer.from("test")]),
      invoke(grant.grant, { ...validHeaders }, [Buffer.from("test")]),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    expect(deliveries).toEqual([{ text: "Report", bytes: Buffer.from("test") }]);
  });

  it.each(["film.bin", 'ролик "версия".mp4'])(
    "delivers the parent's owned ready %s through the selected channel without consuming it",
    async (fileName) => {
      const db = new Database(":memory:");
      databases.push(db);
      createGrantTable(db);
      const store = transfers(db);
      const file = await store.createDownload("user-a", {
        fileName,
        mimeType: "application/octet-stream",
        bytes: Uint8Array.of(0, 1, 255),
      });
      const deliveries: ObservedDelivery[] = [];
      const other: ObservedDelivery[] = [];
      let deliveredName: string | undefined;
      const adapter = configuredAdapter(deliveries);
      const otherAdapter = {
        ...configuredAdapter(other),
        id: "other-channel",
        provider: "other-provider",
      };
      const handler = createManageCommunication({
        communicationService: new UserCommunicationService([
          {
            ...adapter,
            async deliver(message, configuredRepository, context) {
              deliveredName = message.attachment?.filename;
              await adapter.deliver(message, configuredRepository, context);
            },
          },
          otherAdapter,
        ]),
        repository,
        grantService: new CommunicationAttachmentGrantService(db),
        baseUrl: "https://example.invalid",
        audit: async () => {},
        transfers: store,
      });
      const input = {
        action: "deliver-file" as const,
        message: "Film",
        referenceId: file.referenceId,
        kind: "document" as const,
        channelId: "test-channel",
      };
      const foreign = await runWithMCPContext({ userId: "user-b" }, () => handler(input));
      expect(foreign.isError).toBe(true);
      expect(JSON.parse(firstText(foreign))).toEqual({
        status: "rejected",
        reason: "private_file_unavailable",
      });
      expect(deliveries).toEqual([]);
      const delivered = await runWithMCPContext({ userId: "user-a" }, () => handler(input));
      expect(JSON.parse(firstText(delivered))).toMatchObject({
        status: "delivered",
        deliveredChannels: 1,
      });
      expect(deliveries).toEqual([{ text: "Film", bytes: Buffer.from([0, 1, 255]) }]);
      expect(deliveredName).toBe(fileName);
      expect(other).toEqual([]);
      expect((await store.getOwnedSource("user-a", file.referenceId)).source).toMatchObject({
        size: 3,
        sha256: file.sha256,
      });
    },
  );

  it("keeps a grant terminal after a provider attempt fails", async () => {
    const { mint, invoke, validHeaders, deliveries } = harness(true);
    const grant = mint();
    const failed = await invoke(grant.grant, { ...validHeaders }, [Buffer.from("test")]);
    const replay = await invoke(grant.grant, { ...validHeaders }, [Buffer.from("test")]);

    expect(failed.status).toBe(502);
    expect(replay.status).toBe(401);
    expect(deliveries).toEqual([{ text: "Report", bytes: Buffer.from("test") }]);
  });

  it("refuses malformed bodies before provider work and releases the grant for retry", async () => {
    const { mint, invoke, validHeaders, deliveries } = harness();
    const cases: Array<{
      headers: Record<string, string>;
      chunks: Buffer[];
      status: number;
      error: string;
      reads: number;
    }> = [
      {
        headers: { "content-type": "text/plain" },
        chunks: [Buffer.from("test")],
        status: 411,
        error: "content_length_required",
        reads: 0,
      },
      {
        headers: { "content-length": "4", "content-type": "application/pdf" },
        chunks: [Buffer.from("test")],
        status: 400,
        error: "mime_type_mismatch",
        reads: 0,
      },
      {
        headers: { ...validHeaders },
        chunks: [Buffer.from("tes")],
        status: 400,
        error: "body_size_mismatch",
        reads: 1,
      },
      {
        headers: { ...validHeaders },
        chunks: [Buffer.from("test!")],
        status: 413,
        error: "attachment_too_large",
        reads: 1,
      },
    ];

    for (const expected of cases) {
      const grant = mint();
      const refused = await invoke(grant.grant, expected.headers, expected.chunks);
      expect(refused).toEqual(
        expect.objectContaining({
          status: expected.status,
          body: { error: expected.error },
          reads: expected.reads,
        }),
      );
      expect(deliveries).toHaveLength(0);
      const retry = await invoke(grant.grant, { ...validHeaders }, [Buffer.from("test")]);
      expect(retry.status).toBe(200);
      deliveries.splice(0);
    }
  });

  it("refuses occupied live count and byte budgets before reading and permits retry", async () => {
    const { mint, invoke, validHeaders, deliveries, inflight } = harness();
    const occupiedBudgets = [
      () => [inflight.acquire("user-a", 1)!, inflight.acquire("user-a", 1)!],
      () => [inflight.acquire("user-a", MAX_ATTACHMENT_INFLIGHT_BYTES_PER_USER)!],
    ];

    for (const occupy of occupiedBudgets) {
      const releases = occupy();
      const grant = mint();
      const refused = await invoke(grant.grant, { ...validHeaders }, [Buffer.from("test")]);

      expect(refused).toEqual(
        expect.objectContaining({
          status: 429,
          body: { error: "attachment_inflight_limit" },
          reads: 0,
        }),
      );
      expect(deliveries).toHaveLength(0);
      releases.forEach((release) => release());
      expect((await invoke(grant.grant, { ...validHeaders }, [Buffer.from("test")])).status).toBe(
        200,
      );
      deliveries.splice(0);
    }
  });
});
