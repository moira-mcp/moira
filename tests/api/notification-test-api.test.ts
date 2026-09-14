/** Authenticated channel-neutral notification settings API. */

import { beforeAll, describe, expect, test } from "@jest/globals";
import { getTestFetchUrl } from "../utils/test-config.js";
import { createTestUserViaApi, formatSessionCookie, signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestFetchUrl();
const TEST_USER = {
  email: `notification-api-test-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "Notification Test User",
};

let authCookie: string;

beforeAll(async () => {
  await createTestUserViaApi(BASE_URL, TEST_USER.email, TEST_USER.password, TEST_USER.name);
  authCookie = formatSessionCookie(
    BASE_URL,
    await signInUser(BASE_URL, TEST_USER.email, TEST_USER.password),
  );
});

describe("communication channel settings API", () => {
  test("projects the built-in channel without credentials or destinations", async () => {
    const response = await fetch(`${BASE_URL}/api/notifications/channels`, {
      headers: { Cookie: authCookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const telegram = body.data.find((channel) => channel.id === "telegram");
    expect(telegram).toEqual(
      expect.objectContaining({
        title: "Telegram",
        origin: "builtin",
        state: "incomplete",
        configured: false,
        settingKeys: ["telegram.enabled", "telegram.bot_token", "telegram.chat_id"],
      }),
    );
    expect(JSON.stringify(body)).not.toContain("botToken");
    expect(JSON.stringify(body)).not.toContain("chatId");
  });

  test("uses stored current-user settings and rejects browser-supplied authority", async () => {
    const refused = await fetch(`${BASE_URL}/api/notifications/channels/telegram/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: authCookie },
      body: JSON.stringify({ botToken: "browser-token", chatId: "someone-else" }),
    });
    expect(refused.status).toBe(400);

    const testResult = await fetch(`${BASE_URL}/api/notifications/channels/telegram/test`, {
      method: "POST",
      headers: { Cookie: authCookie },
    });
    expect(testResult.status).toBe(200);
    const body = (await testResult.json()) as {
      data: { status: string; channels: Array<{ channelId: string; status: string }> };
    };
    expect(body.data).toEqual(
      expect.objectContaining({
        status: "no_configured_channels",
        channels: [{ channelId: "telegram", status: "not_configured" }],
      }),
    );
  });

  test("does not expose unknown channels and requires authentication", async () => {
    const missing = await fetch(`${BASE_URL}/api/notifications/channels/missing/test`, {
      method: "POST",
      headers: { Cookie: authCookie },
    });
    expect(missing.status).toBe(404);

    const unauthenticated = await fetch(`${BASE_URL}/api/notifications/channels`);
    expect(unauthenticated.status).toBe(401);
  });
});
