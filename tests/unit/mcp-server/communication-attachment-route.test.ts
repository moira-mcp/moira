import { Readable } from "node:stream";
import Database from "better-sqlite3";
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
  db.exec(`CREATE TABLE communication_attachment_grant (
    token_digest TEXT PRIMARY KEY, user_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
    audience TEXT NOT NULL, purpose TEXT NOT NULL, message TEXT NOT NULL, format TEXT NOT NULL,
    silent INTEGER NOT NULL, kind TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
    declared_size INTEGER NOT NULL, state TEXT NOT NULL, claim_id TEXT, claimed_at INTEGER,
    completed_at INTEGER, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
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
    capabilities: { text: true, image: true, document: true, trusted: false },
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
      deliveries.push({
        text: message.text,
        bytes: Buffer.from(message.attachment?.bytes ?? []),
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
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

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
      const response = {
        headersSent: false,
        status(code: number) {
          result.status = code;
          return this;
        },
        json(body: unknown) {
          result.body = body;
          this.headersSent = true;
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
    });

    const result = await runWithMCPContext({ userId: "user-a" }, () =>
      handler({ action: "send", message: "Configured delivery" }),
    );
    expect(JSON.parse(result.content[0].text)).toEqual(
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
    expect(JSON.parse(grantResult.content[0].text)).toEqual(
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
    const cases = [
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
