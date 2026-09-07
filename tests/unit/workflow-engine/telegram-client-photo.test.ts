import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { TelegramClient } from "@mcp-moira/workflow-engine";
import { ServiceLogger } from "@mcp-moira/shared/logging/logger";

describe("TelegramClient photo transport", () => {
  afterEach(() => jest.restoreAllMocks());

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
});
