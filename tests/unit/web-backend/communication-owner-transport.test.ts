import { describe, expect, test } from "@jest/globals";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import express from "express";
import request from "supertest";
import { createCommunicationOwnerRoutes } from "../../../packages/web-backend/src/routes/communication-owner.js";
import { CommunicationOwnerTransport } from "../../../packages/web-backend/src/services/communication-owner-transport.js";
import {
  TelegramCommunicationAdapter,
  CommunicationChannelRegistry,
  type IDataRepository,
} from "@mcp-moira/workflow-engine";
import type { CommunicationOwnerPrepare, CommunicationOwnerSend } from "@mcp-moira/shared";

const scope = {
  kind: "controller" as const,
  userId: "owner",
  deviceId: "620b1509-24ea-48d4-a73e-063fae51e166",
  deviceGeneration: 1,
  connectionId: "6dc89e7d-9ddb-47ab-a29b-e326866df77b",
};
const input: CommunicationOwnerPrepare = {
  scope,
  requestId: "ws1-c2fe6a69-74b9-4a70-a1df-38399297d9f6",
  kind: "document",
  text: "Report",
  file: { fileName: "report.bin", mimeType: "application/octet-stream", size: 3 },
};
const routeBearer = "o".repeat(43);
function fixture(fetcher: typeof fetch) {
  const settings = new Map<string, unknown>([
    ["telegram.bot_token", "123:trusted-secret"],
    ["telegram.chat_id", "42"],
  ]);
  let active = true;
  const service = new CommunicationOwnerTransport({
    authenticate(bearer) {
      if (!active || (bearer !== "owner-bearer" && bearer !== routeBearer))
        throw new Error("refused");
    },
    authorize(_bearer, actual) {
      if (!active || actual.kind !== "controller" || actual.deviceId !== scope.deviceId)
        throw new Error("revoked");
      return "owner";
    },
    repository: {
      getSetting: async (_user: string, key: string) => settings.get(key) ?? null,
    } as unknown as IDataRepository,
    registry: new CommunicationChannelRegistry([new TelegramCommunicationAdapter()]),
    fetch: fetcher,
  });
  return {
    service,
    settings,
    revoke: () => {
      active = false;
    },
  };
}
async function sendInput(
  service: CommunicationOwnerTransport,
  change: Partial<CommunicationOwnerSend> = {},
) {
  const preparation = await service.prepare("owner-bearer", input);
  return {
    ...input,
    channelId: "telegram",
    authorityDigest: preparation.channels[0]!.authorityDigest,
    ...change,
  };
}

describe("fixed owner communication transport", () => {
  test.each([
    { path: "/send", expected: { status: "refused", reason: "owner_unauthorized" } },
    {
      path: "/prepare",
      expected: {
        error: {
          code: "COMMUNICATION_AUTHORITY_REFUSED",
          message: "Channel or owner authority refused before delivery.",
        },
      },
    },
  ])(
    "a shaped forged bearer is refused at $path before opening its body",
    async ({ path, expected }) => {
      let reads = 0,
        vendorCalls = 0;
      const f = fixture((async () => {
        vendorCalls++;
        return Response.json({ ok: true });
      }) as typeof fetch);
      const incoming = Object.assign(
        new Readable({
          read() {
            reads++;
            this.push(Buffer.alloc(4));
            this.push(null);
          },
        }),
        {
          socket: Object.assign(new EventEmitter(), { destroyed: false }),
          method: "POST",
          url: path,
          headers: { authorization: `Bearer ${"f".repeat(43)}` },
          get(name: string) {
            return this.headers[name.toLowerCase() as "authorization"];
          },
        },
      );
      let statusCode = 200;
      const headers: Record<string, unknown> = {};
      const result = new Promise<unknown>((resolve, reject) => {
        const response = Object.assign(new EventEmitter(), {
          destroyed: false,
          headersSent: false,
          writableEnded: false,
          setHeader(name: string, value: unknown) {
            headers[name.toLowerCase()] = value;
            return this;
          },
          status(value: number) {
            statusCode = value;
            return this;
          },
          json(value: unknown) {
            this.writableEnded = true;
            resolve(value);
            return this;
          },
        });
        createCommunicationOwnerRoutes(f.service)(
          incoming as unknown as Request,
          response as unknown as Response,
          reject,
        );
      });
      expect(await result).toEqual(expected);
      expect(statusCode).toBe(403);
      expect(headers.connection).toBe("close");
      expect(reads).toBe(0);
      expect(vendorCalls).toBe(0);
      incoming.socket.destroyed = true;
      incoming.socket.emit("close");
      expect(incoming.destroyed).toBe(true);
    },
  );

  test("authenticated preparation accepts large controls, rejects invalid JSON, and rechecks revoked authority", async () => {
    const f = fixture((async () => {
      throw new Error("Preparation cannot dispatch");
    }) as typeof fetch);
    const app = express();
    app.use(createCommunicationOwnerRoutes(f.service));
    const body = { ...input, file: { ...input.file, fileName: `${"中".repeat(40_000)}.bin` } };
    const prepared = await request(app)
      .post("/prepare")
      .set("Authorization", `Bearer ${routeBearer}`)
      .send(body);
    expect(prepared.status).toBe(200);
    expect(prepared.body.channels).toEqual([
      expect.objectContaining({ channelId: "telegram", provider: "telegram" }),
    ]);
    const malformed = await request(app)
      .post("/prepare")
      .set("Authorization", `Bearer ${routeBearer}`)
      .set("Content-Type", "application/json")
      .send('{"scope":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("COMMUNICATION_REQUEST_INVALID");
    f.revoke();
    const revoked = await request(app)
      .post("/prepare")
      .set("Authorization", `Bearer ${routeBearer}`)
      .send(body);
    expect(revoked.status).toBe(403);
    expect(revoked.body.error.code).toBe("COMMUNICATION_AUTHORITY_REFUSED");
  });

  test("streams the exact opaque file chunk while only the cloud chooses the secret and recipient framing", async () => {
    const raw = Uint8Array.of(0, 255, 1);
    const observed: unknown[] = [];
    let endpoint = "";
    const f = fixture((async (url, init) => {
      endpoint = String(url);
      for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>)
        observed.push(chunk);
      return Response.json({ ok: true });
    }) as typeof fetch);
    expect(
      await f.service.send(
        "owner-bearer",
        await sendInput(f.service),
        (async function* () {
          yield raw;
        })(),
      ),
    ).toEqual({ status: "delivered" });
    expect(endpoint).toBe("https://api.telegram.org/bot123:trusted-secret/sendDocument");
    expect(observed[1]).toBe(raw);
    expect(Buffer.from(observed[0] as Uint8Array).toString()).toContain(
      'name="chat_id"\r\n\r\n42\r\n',
    );
    expect(Buffer.from(observed[0] as Uint8Array).toString()).toContain('filename="report.bin"');
    expect(observed).toHaveLength(3);
  });

  test("configuration replacement refuses an already prepared destination before opening its source", async () => {
    let vendorCalls = 0,
      reads = 0;
    const f = fixture((async () => {
      vendorCalls++;
      return Response.json({ ok: true });
    }) as typeof fetch);
    const prepared = await sendInput(f.service);
    f.settings.set("telegram.chat_id", "other");
    expect(
      await f.service.send(
        "owner-bearer",
        prepared,
        (async function* () {
          reads++;
          yield Uint8Array.of(1);
        })(),
      ),
    ).toEqual({ status: "refused", reason: "channel_changed" });
    expect(vendorCalls).toBe(0);
    expect(reads).toBe(0);
  });

  test("revoked source actor and undeclared recipient controls cannot dispatch", async () => {
    let vendorCalls = 0;
    const f = fixture((async () => {
      vendorCalls++;
      return Response.json({ ok: true });
    }) as typeof fetch);
    const prepared = await sendInput(f.service);
    f.revoke();
    expect(
      (
        await f.service.send(
          "owner-bearer",
          prepared,
          (async function* () {
            yield Uint8Array.of(1);
          })(),
        )
      ).status,
    ).toBe("refused");
    const second = fixture((async () => {
      vendorCalls++;
      return Response.json({ ok: true });
    }) as typeof fetch);
    expect(
      (
        await second.service.send(
          "owner-bearer",
          { ...(await sendInput(second.service)), recipient: "attacker" },
          (async function* () {
            yield Uint8Array.of(1);
          })(),
        )
      ).status,
    ).toBe("refused");
    expect(vendorCalls).toBe(0);
  });

  test("a success response before the raw source is consumed cannot certify delivery", async () => {
    const f = fixture((async () => Response.json({ ok: true })) as typeof fetch);
    expect(
      await f.service.send(
        "owner-bearer",
        await sendInput(f.service),
        (async function* () {
          yield Uint8Array.of(0, 255, 1);
        })(),
      ),
    ).toEqual({ status: "unconfirmed", reason: "source_incomplete" });
  });

  test("an early vendor response interrupts a pending physical source read before settling", async () => {
    let beginRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      beginRead = resolve;
    });
    const source = new Readable({
      read() {
        beginRead();
      },
    });
    let upload!: Promise<unknown>;
    const f = fixture((async (_url, init) => {
      upload = (async () => {
        try {
          for await (const _chunk of init!.body as unknown as AsyncIterable<Uint8Array>) {
            /* pending input */
          }
        } catch {
          /* transport cancellation */
        }
      })();
      await reading;
      return Response.json({ ok: true });
    }) as typeof fetch);
    expect(await f.service.send("owner-bearer", await sendInput(f.service), source)).toEqual({
      status: "unconfirmed",
      reason: "source_incomplete",
    });
    await upload;
    expect(source.closed).toBe(true);
  });

  test("provider upload bounds are checked before returning an admission descriptor", async () => {
    const f = fixture((async () => {
      throw new Error("must not dispatch");
    }) as typeof fetch);
    await expect(
      f.service.prepare("owner-bearer", {
        ...input,
        channelIds: ["telegram"],
        kind: "image",
        file: { ...input.file, mimeType: "image/png", size: 10 * 1024 * 1024 + 1 },
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.service.prepare("owner-bearer", {
          ...input,
          file: { ...input.file, size: 50 * 1024 * 1024 },
        })
      ).channels,
    ).toHaveLength(1);
  });

  test("source interruption after vendor dispatch stays uncertain rather than becoming a refusal", async () => {
    const f = fixture((async (_url, init) => {
      for await (const _chunk of init!.body as unknown as AsyncIterable<Uint8Array>) {
        /* Consume the actual streaming input. */
      }
      return Response.json({ ok: true });
    }) as typeof fetch);
    expect(
      await f.service.send(
        "owner-bearer",
        await sendInput(f.service),
        (async function* () {
          yield Uint8Array.of(0);
          throw new Error("source interrupted");
        })(),
      ),
    ).toEqual({ status: "unconfirmed", reason: "provider_outcome_unconfirmed" });
  });

  test("a separately journaled long-caption text stage uses the same fixed recipient with no file body", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const f = fixture((async (url, init) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>)
        chunks.push(chunk);
      requests.push({ url: String(url), body: Buffer.concat(chunks).toString() });
      return Response.json({ ok: true });
    }) as typeof fetch);
    const stage = await sendInput(f.service, {
      operationId: "send_message",
      text: "A".repeat(2000),
      file: { ...input.file, size: 0 },
    });
    expect(await f.service.send("owner-bearer", stage, (async function* () {})())).toEqual({
      status: "delivered",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.endsWith("/sendMessage")).toBe(true);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ chat_id: "42", text: "A".repeat(2000) });
  });
});
