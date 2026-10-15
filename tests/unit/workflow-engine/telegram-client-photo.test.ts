import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { TelegramClient } from "@mcp-moira/workflow-engine";
import { ServiceLogger } from "@mcp-moira/shared/logging/logger";

describe("TelegramClient text metadata privacy", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test("default text delivery waits for the provider and does not impose a local per-minute budget", async () => {
    jest.useFakeTimers();
    let release!: (value: Response) => void;
    const fetch = jest
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        (_input, init) =>
          new Promise<Response>((resolve, reject) => {
            release = resolve;
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      )
      .mockImplementation(async () => Response.json({ ok: true }));
    const client = new TelegramClient({ botToken: "123:private-token" });
    let settled = false;
    const held = client
      .sendMessage({ chatId: "private-chat", text: "original text" })
      .finally(() => {
        settled = true;
      });
    held.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(60_001);
    expect(settled).toBe(false);
    release(Response.json({ ok: true }));
    await expect(held).resolves.toMatchObject({ ok: true });
    for (let index = 0; index < 40; index++)
      await client.sendMessage({ chatId: "private-chat", text: `message ${index}` });
    expect(fetch).toHaveBeenCalledTimes(41);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).text).toBe("original text");
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
