import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { TelegramClient } from "@mcp-moira/workflow-engine";

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
});
