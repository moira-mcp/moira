import { describe, expect, it } from "@jest/globals";
import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CommunicationChannelRegistry,
  TelegramCommunicationAdapter,
  type IDataRepository,
} from "@mcp-moira/workflow-engine";
import { CommunicationOwnerTransport } from "../../packages/web-backend/src/services/communication-owner-transport.js";
import { createCommunicationOwnerRoutes } from "../../packages/web-backend/src/routes/communication-owner.js";
import { createRateLimiters } from "../../packages/web-backend/src/middleware/rate-limit-middleware.js";
import {
  encodeOwnerFrame,
  OWNER_STREAM_CONTENT_TYPE,
} from "../../packages/workspace-service/src/stream-frame.mjs";

describe("Telegram streamed attachment HTTP transport", () => {
  it("delivers MP4 and quoted Unicode JPG documents through one live owner and vendor HTTP fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "moira-telegram-stream-"));
    const receiverPath = join(root, "received-document.bin");
    const chunk = Buffer.alloc(256 * 1024, 0xa7);
    const count = 20;
    const expected = createHash("sha256");
    for (let index = 0; index < count; index++) expected.update(chunk);
    const digest = expected.digest("hex");
    let observed: {
      size: number;
      sha256: string;
      name: string;
      mime: string;
      caption: string;
      chatId: string;
    } | null = null;
    const app = express();
    const credential = "a".repeat(43);
    const scope = {
      kind: "controller" as const,
      userId: "owner",
      deviceId: randomUUID(),
      deviceGeneration: 1,
      connectionId: randomUUID(),
    };
    const preparation = {
      scope,
      requestId: `ws1-${randomUUID()}`,
      channelIds: ["telegram"],
      kind: "document" as const,
      text: "Report",
      file: {
        fileName: "film.mp4",
        mimeType: "video/mp4",
        size: chunk.length * count,
      },
    };
    const vendorUrls: string[] = [];
    const transport = new CommunicationOwnerTransport({
      authenticate: (bearer) => {
        if (bearer !== credential) throw new Error("Foreign owner credential");
      },
      authorize: (bearer, owner) => {
        if (bearer !== credential || JSON.stringify(owner) !== JSON.stringify(scope))
          throw new Error("Foreign owner");
        return "owner";
      },
      registry: new CommunicationChannelRegistry([new TelegramCommunicationAdapter()]),
      repository: {
        getSetting: async (_user: string, key: string) =>
          (
            ({
              "telegram.enabled": true,
              "telegram.bot_token": "123:fixture",
              "telegram.chat_id": "7",
            }) as Record<string, unknown>
          )[key],
      } as unknown as IDataRepository,
      fetch: async (url, options) => {
        vendorUrls.push(String(url));
        return fetch("http://127.0.0.1:3098/bot123:fixture/sendDocument", options);
      },
    });
    app.use("/api/communication/owner", createCommunicationOwnerRoutes(transport));
    const { apiLimiter } = createRateLimiters({ skipLimits: false, whitelist: [] });
    app.post(
      "/bot123:fixture/sendDocument",
      apiLimiter,
      multer({
        storage: multer.diskStorage({
          destination: root,
          filename: (_request, _file, done) => done(null, "received-document.bin"),
        }),
        limits: {
          fileSize: 20 * 1024 * 1024,
          files: 1,
          fields: 2,
          fieldSize: 1024,
          parts: 3,
        },
      }).single("document"),
      async (req, res) => {
        try {
          if (!req.file) throw new Error("Multipart file is missing");
          const hash = createHash("sha256");
          let size = 0;
          for await (const bytes of createReadStream(receiverPath)) {
            size += bytes.length;
            hash.update(bytes);
          }
          observed = {
            size,
            sha256: hash.digest("hex"),
            // Multer's Busboy decoder uses Latin-1 for ordinary filename parameters.
            // Recover the wire UTF-8 bytes explicitly; this fixture is not Telegram.
            name: Buffer.from(req.file.originalname, "latin1").toString("utf8"),
            mime: req.file.mimetype,
            caption: req.body.caption,
            chatId: req.body.chat_id,
          };
          res.json({ ok: true });
        } catch {
          res.status(400).json({ ok: false, description: "Invalid test attachment" });
        }
      },
    );
    const server = createServer(app);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(3098, "127.0.0.1", resolve);
      });
      // Keep the fixture listening while both actions run. A global HTTP pool
      // must never be pointed at a different server that just reused its port.
      for (const filename of ["film.mp4", 'сцена "версия".jpg']) {
        observed = null;
        vendorUrls.length = 0;
        const current = {
          ...preparation,
          requestId: `ws1-${randomUUID()}`,
          file: {
            ...preparation.file,
            fileName: filename,
            mimeType: filename.endsWith(".jpg") ? "image/jpeg" : "video/mp4",
          },
        };
        const prepared = await transport.prepare(credential, current);
        expect(prepared.channels).toHaveLength(1);
        const { channelIds: _channelIds, ...control } = current;
        const framed = encodeOwnerFrame(
          {
            ...control,
            channelId: "telegram",
            authorityDigest: prepared.channels[0]!.authorityDigest,
          },
          (async function* () {
            for (let index = 0; index < count; index++) yield chunk;
          })(),
        );
        const reply = await fetch("http://127.0.0.1:3098/api/communication/owner/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential}`,
            "Content-Type": OWNER_STREAM_CONTENT_TYPE,
            "Content-Length": String(framed.prefixLength + current.file.size),
          },
          body: Readable.from(framed.body) as unknown as BodyInit,
          duplex: "half",
        } as RequestInit & { duplex: "half" });
        expect(reply.status).toBe(200);
        expect(await reply.json()).toEqual({ status: "delivered" });
        expect(vendorUrls).toEqual(["https://api.telegram.org/bot123:fixture/sendDocument"]);
        expect(observed).toEqual({
          size: chunk.length * count,
          sha256: digest,
          name: filename,
          mime: current.file.mimeType,
          caption: "Report",
          chatId: "7",
        });
      }
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
