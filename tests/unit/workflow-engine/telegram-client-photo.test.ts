import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { TelegramClient } from "@mcp-moira/workflow-engine";
import { ServiceLogger } from "@mcp-moira/shared/logging/logger";
import { createHash } from "node:crypto";
import { ownedByteStream } from "../../helpers/owned-byte-stream.js";

describe("TelegramClient photo transport", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("sends a real PNG multipart body with caption and options", async () => {
    let captured: FormData | undefined;
    jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      captured = init?.body as FormData;
      return Response.json({
        ok: true,
        result: { messageId: 1, date: 1, chat: { id: 7, type: "private" } },
      });
    });
    const client = new TelegramClient({ botToken: "123:token", defaultChatId: "7" });
    const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a", "hex"));
    await client.sendPhoto({
      chatId: "7",
      photo: png,
      filename: "progress.png",
      mimeType: "image/png",
      caption: "Current progress",
      parseMode: "HTML",
      disableNotification: true,
      replyMarkup: { inline_keyboard: [[{ text: "Open", url: "https://example.com" }]] },
    });
    expect(captured?.get("chat_id")).toBe("7");
    expect(captured?.get("caption")).toBe("Current progress");
    expect(captured?.get("parse_mode")).toBe("HTML");
    expect(captured?.get("disable_notification")).toBe("true");
    expect(captured?.get("reply_markup")).toContain("inline_keyboard");
    const photo = captured?.get("photo") as File;
    expect(photo.name).toBe("progress.png");
    expect(photo.type).toBe("image/png");
    expect(Buffer.from(await photo.arrayBuffer()).toString("hex")).toBe("89504e470d0a1a0a");
  });

  test("rejects empty and oversized photos before allocating multipart bodies", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    const client = new TelegramClient({ botToken: "123:token", defaultChatId: "7" });
    await expect(
      client.sendPhoto({
        chatId: "7",
        photo: new Uint8Array(),
        filename: "empty.jpg",
        mimeType: "image/jpeg",
      }),
    ).rejects.toThrow("Photo size must be between");
    await expect(
      client.sendPhoto({
        chatId: "7",
        photo: new Uint8Array(10 * 1024 * 1024 + 1),
        filename: "large.jpg",
        mimeType: "image/jpeg",
      }),
    ).rejects.toThrow("Photo size must be between");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("sends a document as multipart data without altering its bytes", async () => {
    let captured: FormData | undefined;
    jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      captured = init?.body as FormData;
      return Response.json({ ok: true });
    });
    const client = new TelegramClient({ botToken: "123:token", defaultChatId: "7" });
    await client.sendDocument({
      chatId: "7",
      document: Uint8Array.from([0, 1, 2, 255]),
      filename: "report.pdf",
      mimeType: "application/pdf",
      caption: "Report",
    });
    expect(captured?.get("chat_id")).toBe("7");
    expect(captured?.get("caption")).toBe("Report");
    const document = captured?.get("document") as File;
    expect(document.name).toBe("report.pdf");
    expect(document.type).toBe("application/pdf");
    expect([...new Uint8Array(await document.arrayBuffer())]).toEqual([0, 1, 2, 255]);
  });

  test("logs delivery metadata without token, destination, or message content", async () => {
    const info = jest.spyOn(ServiceLogger.prototype, "info").mockImplementation(() => undefined);
    const debug = jest.spyOn(ServiceLogger.prototype, "debug").mockImplementation(() => undefined);
    jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ ok: true }));
    const client = new TelegramClient({
      botToken: "123:private-token",
      defaultChatId: "private-destination",
      apiUrl: "https://private-api.example/embedded-secret/",
    });
    await client.sendMessage({ chatId: "private-destination", text: "private-message" });
    await client.testConnection();
    const emitted = JSON.stringify([info.mock.calls, debug.mock.calls]);
    expect(emitted).toContain("messageLength");
    expect(emitted).not.toContain("private-token");
    expect(emitted).not.toContain("private-destination");
    expect(emitted).not.toContain("private-message");
    expect(emitted).not.toContain("embedded-secret");
  });

  test.each(["photo", "document"] as const)(
    "does not send a buffered %s after its parent has cancelled",
    async (kind) => {
      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ ok: true }));
      const controller = new AbortController();
      controller.abort();
      const client = new TelegramClient({ botToken: "123:token" });
      const params = {
        chatId: "7",
        filename: "attachment.bin",
        mimeType: "application/octet-stream",
        signal: controller.signal,
      };
      const send =
        kind === "photo"
          ? client.sendPhoto({ ...params, mimeType: "image/png", photo: Uint8Array.of(1) })
          : client.sendDocument({ ...params, document: Uint8Array.of(1) });
      await expect(send).rejects.toThrow("cancelled or timed out");
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  test.each(["film.mp4", 'ролик "версия".mp4'])(
    "streams %s through bounded multipart chunks with exact bytes",
    async (filename) => {
      const chunk = Buffer.alloc(256 * 1024, 0xa7);
      const count = 20;
      const expected = createHash("sha256");
      for (let index = 0; index < count; index++) expected.update(chunk);
      const digest = expected.digest("hex");
      let read = 0;
      const source = {
        size: chunk.length * count,
        sha256: digest,
        async open() {
          return ownedByteStream(
            (async function* () {
              for (let index = 0; index < count; index++) {
                read++;
                yield chunk;
              }
            })(),
          );
        },
      };
      jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
        expect(read).toBe(0);
        const iterator = (init?.body as unknown as AsyncIterable<Uint8Array>)[
          Symbol.asyncIterator
        ]();
        const prefix = Buffer.from((await iterator.next()).value).toString();
        expect(prefix).toContain(`name="document"; filename="${filename.replaceAll('"', '\\"')}"`);
        expect(prefix).toContain("Content-Type: video/mp4");
        expect(prefix).toContain("Report");
        const observed = createHash("sha256");
        for (let index = 0; index < count; index++) {
          const bytes = (await iterator.next()).value;
          expect(bytes.byteLength).toBe(chunk.length);
          observed.update(bytes);
        }
        expect(observed.digest("hex")).toBe(digest);
        expect(Buffer.from((await iterator.next()).value).toString()).toMatch(/^\r\n--.+--\r\n$/);
        expect((await iterator.next()).done).toBe(true);
        expect(read).toBe(count);
        return Response.json({ ok: true });
      });
      await new TelegramClient({ botToken: "123:token" }).sendDocument({
        chatId: "7",
        document: source,
        filename,
        mimeType: "video/mp4",
        caption: "Report",
      });
    },
  );

  test.each([
    "",
    ".",
    "..",
    "dir/file.bin",
    "dir\\file.bin",
    "bad\r\nheader",
    "bad\0name",
    "я".repeat(128),
  ])("refuses unsafe streamed filename %j before opening or sending bytes", async (filename) => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(Response.json({ ok: true }));
    const open = jest.fn(async () =>
      ownedByteStream(
        (async function* () {
          yield Uint8Array.of(1);
        })(),
      ),
    );
    await expect(
      new TelegramClient({ botToken: "123:token" }).sendDocument({
        chatId: "7",
        filename,
        mimeType: "application/octet-stream",
        document: {
          size: 1,
          sha256: createHash("sha256").update(Uint8Array.of(1)).digest("hex"),
          open,
        },
      }),
    ).rejects.toThrow("filename or MIME type is invalid");
    expect(open).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each(["size", "digest"])("rejects a streamed document with changed %s", async (fault) => {
    const bytes = Buffer.from("test");
    const source = {
      size: fault === "size" ? 5 : 4,
      sha256:
        fault === "digest" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"),
      async open() {
        return ownedByteStream(
          (async function* () {
            yield bytes;
          })(),
        );
      },
    };
    jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) void chunk;
      return Response.json({ ok: true });
    });
    await expect(
      new TelegramClient({ botToken: "123:token" }).sendDocument({
        chatId: "7",
        document: source,
        filename: "report.bin",
        mimeType: "application/octet-stream",
      }),
    ).rejects.toThrow("Streamed attachment");
  });

  test("cancels a streamed attachment and closes its source when the parent aborts", async () => {
    const controller = new AbortController();
    let reads = 0;
    let closed = false;
    const source = {
      size: 2,
      sha256: createHash("sha256").update(Uint8Array.of(1, 2)).digest("hex"),
      async open(signal?: AbortSignal) {
        return ownedByteStream(
          (async function* () {
            try {
              for (const byte of [1, 2]) {
                signal?.throwIfAborted();
                reads++;
                yield Uint8Array.of(byte);
              }
            } finally {
              closed = true;
            }
          })(),
        );
      },
    };
    jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      const iterator = (init?.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
      await iterator.next();
      expect([...(await iterator.next()).value]).toEqual([1]);
      controller.abort();
      await iterator.next();
      return Response.json({ ok: true });
    });
    await expect(
      new TelegramClient({ botToken: "123:token" }).sendDocument({
        chatId: "7",
        document: source,
        filename: "report.bin",
        mimeType: "application/octet-stream",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled or timed out");
    expect(reads).toBe(1);
    expect(closed).toBe(true);
  });
});
