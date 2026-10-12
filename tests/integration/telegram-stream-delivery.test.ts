import { describe, expect, it } from "@jest/globals";
import express from "express";
import multer from "multer";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramClient } from "@mcp-moira/workflow-engine";
import { ownedByteStream } from "../helpers/owned-byte-stream.js";
import { createRateLimiters } from "../../packages/web-backend/src/middleware/rate-limit-middleware.js";

describe("Telegram streamed attachment HTTP transport", () => {
  it.each(["film.mp4", 'ролик "версия".mp4'])(
    "delivers %s as a complete multipart file through native fetch",
    async (filename) => {
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
        const response = await new TelegramClient({
          botToken: "123:fixture",
          apiUrl: "http://127.0.0.1:3098/bot",
        }).sendDocument({
          chatId: "7",
          filename,
          mimeType: "video/mp4",
          caption: "Report",
          document: {
            size: chunk.length * count,
            sha256: digest,
            async open() {
              return ownedByteStream(
                (async function* () {
                  for (let index = 0; index < count; index++) yield chunk;
                })(),
              );
            },
          },
        });
        expect(response.ok).toBe(true);
        expect(observed).toEqual({
          size: chunk.length * count,
          sha256: digest,
          name: filename,
          mime: "video/mp4",
          caption: "Report",
          chatId: "7",
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
