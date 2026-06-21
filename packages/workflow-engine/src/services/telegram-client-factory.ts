/**
 * TelegramClient Factory for clean dependency management
 * Eliminates constructor pollution while enabling test mocking
 */

import { TelegramClient } from "./telegram-client.js";

type TelegramClientFactory = (botToken?: string, chatId?: string) => TelegramClient | null;

// Default factory creates client from provided parameters
let clientFactory: TelegramClientFactory = (botToken?: string, chatId?: string) => {
  if (!botToken) return null;
  return new TelegramClient({ botToken, defaultChatId: chatId });
};

/**
 * Get TelegramClient instance using current factory
 * Accepts botToken and chatId from settings repository
 */
export function getTelegramClient(botToken?: string, chatId?: string): TelegramClient | null {
  return clientFactory(botToken, chatId);
}

/**
 * Override client factory for testing
 * Allows test injection without constructor pollution
 */
export function setTestClientFactory(factory: TelegramClientFactory) {
  clientFactory = factory;
}

/**
 * Reset to default parameter-based factory
 * Useful for test cleanup
 */
export function resetClientFactory() {
  clientFactory = (botToken?: string, chatId?: string) => {
    if (!botToken) return null;
    return new TelegramClient({ botToken, defaultChatId: chatId });
  };
}
