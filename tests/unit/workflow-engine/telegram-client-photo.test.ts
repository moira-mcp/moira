import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { TelegramClient } from "@mcp-moira/workflow-engine";
import { ServiceLogger } from "@mcp-moira/shared/logging/logger";

describe("TelegramClient text metadata privacy", () => {
  afterEach(() => {
    jest.restoreAllMocks();
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
