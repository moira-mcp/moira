/**
 * Integration Test - Telegram User Settings
 * Validates that workflow execution loads per-user telegram settings from repository
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";

describe("Telegram User Settings Integration", () => {
  let repository: DatabaseRepository;
  const testUserId = "system-admin"; // Use existing admin user from seed

  beforeAll(() => {
    repository = new DatabaseRepository();
  });

  test("handler loads telegram settings from repository per-user", async () => {
    // Save user-specific telegram settings
    await repository.setSetting(testUserId, "telegram.bot_token", "user-specific-token-123");
    await repository.setSetting(testUserId, "telegram.chat_id", "999888777");
    await repository.setSetting(testUserId, "telegram.enabled", true);

    // Load back settings
    const botToken = await repository.getSetting<string>(testUserId, "telegram.bot_token");
    const chatId = await repository.getSetting<string>(testUserId, "telegram.chat_id");
    const enabled = await repository.getSetting<boolean>(testUserId, "telegram.enabled");

    // Verify settings loaded correctly
    expect(botToken).toBe("user-specific-token-123");
    expect(chatId).toBe("999888777");
    expect(enabled).toBe(true);
  });

  test("encrypted telegram.bot_token handled automatically by repository", async () => {
    // Save encrypted setting
    const secretToken = "123456:ABCDEFencryptedToken";
    await repository.setSetting(testUserId, "telegram.bot_token", secretToken);

    // Load back - should be decrypted automatically
    const loadedToken = await repository.getSetting<string>(testUserId, "telegram.bot_token");

    // Verify token loaded (repository handles encryption/decryption)
    expect(loadedToken).toBe(secretToken);
  });

  test("user without settings returns null (env fallback path)", async () => {
    const nonExistentUserId = "user-without-settings-" + Date.now();

    const botToken = await repository.getSetting<string>(nonExistentUserId, "telegram.bot_token");
    const chatId = await repository.getSetting<string>(nonExistentUserId, "telegram.chat_id");

    // Should return null when no settings configured
    expect(botToken).toBeNull();
    expect(chatId).toBeNull();
  });
});
