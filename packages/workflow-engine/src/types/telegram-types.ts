/**
 * Telegram Bot API Type Definitions
 * Type-safe interfaces for Telegram notification functionality
 */

/**
 * Configuration for Telegram Bot integration
 * Loaded from environment variables via MCP server configuration
 */
export interface TelegramConfig {
  /** Bot API token from BotFather */
  botToken: string;
  /** Optional default chat ID for notifications */
  defaultChatId?: string;
  /** Telegram API base URL (default: https://api.telegram.org/bot) */
  apiUrl?: string;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
}

/**
 * Parameters for sending a Telegram message
 * Maps to Telegram Bot API sendMessage method parameters
 */
export interface SendMessageParams {
  /** Unique identifier for the target chat */
  chatId: string;
  /** Text of the message to be sent, 1-4096 characters */
  text: string;
  /** Send Markdown or HTML for rich formatting */
  parseMode?: "Markdown" | "HTML";
  /** Sends the message silently without notification */
  disableNotification?: boolean;
  /** Optional inline keyboard or other reply markup */
  replyMarkup?: ReplyMarkup;
}

/**
 * Response from Telegram Bot API
 * Simplified version focusing on essential fields
 */
export interface TelegramResponse {
  /** True if the request was successful */
  ok: boolean;
  /** Result object containing message information */
  result?: {
    /** Unique message identifier inside chat */
    messageId: number;
    /** Date the message was sent in Unix timestamp */
    date: number;
    /** Chat information */
    chat: {
      /** Unique identifier for the chat */
      id: number;
      /** Type of chat (private, group, supergroup, channel) */
      type: string;
    };
  };
  /** Error code for failed requests */
  errorCode?: number;
  /** Human-readable description of the error */
  description?: string;
}

/**
 * Telegram API error types for proper error handling
 */
export enum TelegramErrorType {
  /** Bot token is missing or invalid */
  INVALID_TOKEN = "invalid_token",
  /** Chat ID is invalid or bot doesn't have access */
  INVALID_CHAT_ID = "invalid_chat_id",
  /** Network connectivity issues */
  NETWORK_ERROR = "network_error",
  /** Telegram API returned an error */
  API_ERROR = "api_error",
  /** Message template processing failed */
  TEMPLATE_ERROR = "template_error",
  /** Rate limit exceeded */
  RATE_LIMIT_EXCEEDED = "rate_limit_exceeded",
  /** Request timeout */
  TIMEOUT_ERROR = "timeout_error",
  /** Message is too long (>4096 characters) */
  MESSAGE_TOO_LONG = "message_too_long",
}

/**
 * Structured error for Telegram operations
 * Provides detailed context for debugging and error handling
 */
export interface TelegramError extends Error {
  /** Specific error type for programmatic handling */
  type: TelegramErrorType;
  /** Original error from HTTP client or Telegram API */
  originalError?: unknown;
  /** Additional context data */
  context?: Record<string, unknown>;
}

/**
 * Rate limiter configuration and state
 * Simple implementation for Telegram API rate limiting
 */
export interface RateLimiterConfig {
  /** Maximum requests per time window */
  maxRequests: number;
  /** Time window in milliseconds */
  timeWindow: number;
}

/**
 * Rate limiter internal state tracking
 */
export interface RateLimiterState {
  /** Timestamps of recent requests */
  requestTimestamps: number[];
  /** Last cleanup timestamp */
  lastCleanup: number;
}

/**
 * Result of rate limit check
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Milliseconds until next request is allowed (if not allowed) */
  retryAfter?: number;
  /** Current request count in time window */
  currentCount: number;
}

/**
 * Get actionable error message for a TelegramErrorType
 * Used by handler and API endpoints to provide clear guidance to users
 */
export function getActionableTelegramErrorMessage(
  type: TelegramErrorType,
  originalMessage?: string,
): string {
  switch (type) {
    case TelegramErrorType.INVALID_CHAT_ID:
      return "Chat not found. You need to send any message to your bot first, then try again.";
    case TelegramErrorType.INVALID_TOKEN:
      return "Bot token is invalid or expired. Get a new token from @BotFather and update it in Settings → Telegram.";
    case TelegramErrorType.NETWORK_ERROR:
      return "Network error connecting to Telegram API. Check internet connection and try again.";
    case TelegramErrorType.RATE_LIMIT_EXCEEDED:
      return "Telegram API rate limit reached. Please wait a moment and try again.";
    case TelegramErrorType.TIMEOUT_ERROR:
      return "Telegram API request timed out. Please try again.";
    case TelegramErrorType.MESSAGE_TOO_LONG:
      return "Message exceeds 4096 character limit. Shorten the message template.";
    case TelegramErrorType.TEMPLATE_ERROR:
      return `Template processing error: ${originalMessage || "unknown"}`;
    case TelegramErrorType.API_ERROR:
    default:
      return originalMessage
        ? `Telegram notification failed: ${originalMessage}`
        : "Telegram notification failed";
  }
}

/**
 * Classify an unknown error as a TelegramError type
 * Returns the error type and original message for structured error responses
 */
export function classifyTelegramError(error: unknown): {
  errorType: TelegramErrorType;
  message: string;
} {
  // Already a TelegramError
  if (error && typeof error === "object" && "type" in error) {
    const telegramError = error as TelegramError;
    return {
      errorType: telegramError.type,
      message: getActionableTelegramErrorMessage(telegramError.type, telegramError.message),
    };
  }

  // Generic Error
  if (error instanceof Error) {
    return {
      errorType: TelegramErrorType.API_ERROR,
      message: getActionableTelegramErrorMessage(TelegramErrorType.API_ERROR, error.message),
    };
  }

  return {
    errorType: TelegramErrorType.API_ERROR,
    message: getActionableTelegramErrorMessage(TelegramErrorType.API_ERROR),
  };
}

// --- Inline Keyboard Types (Telegram Bot API) ---

/**
 * Represents one button in an inline keyboard row
 * @see https://core.telegram.org/bots/api#inlinekeyboardbutton
 */
export interface InlineKeyboardButton {
  /** Label text on the button */
  text: string;
  /** Data sent in a callback query when button is pressed (1-64 bytes) */
  callback_data?: string;
  /** HTTP or tg:// URL to be opened when button is pressed */
  url?: string;
}

/**
 * Inline keyboard markup attached to a message
 * @see https://core.telegram.org/bots/api#inlinekeyboardmarkup
 */
export interface InlineKeyboardMarkup {
  /** Array of button rows, each row is an array of InlineKeyboardButton */
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Union type for supported reply markup options.
 * Currently only InlineKeyboardMarkup is supported.
 */
export type ReplyMarkup = InlineKeyboardMarkup;

/**
 * Max callback_data size in bytes allowed by Telegram Bot API.
 * @see https://core.telegram.org/bots/api#inlinekeyboardbutton
 */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Build an inline keyboard for approve action.
 * Uses compact encoding to stay within Telegram's 64-byte callback_data limit.
 * Format: "a:<exec8>:<nodeId12>"
 * The lock service maps short prefixes back to full IDs.
 */
export function buildApproveKeyboard(executionId: string, nodeId: string): InlineKeyboardMarkup {
  const execShort = executionId.substring(0, 8);
  const nodeShort = nodeId.substring(0, 12);
  return {
    inline_keyboard: [
      [
        {
          text: "✅ Approve",
          callback_data: `a:${execShort}:${nodeShort}`,
        },
      ],
    ],
  };
}

/**
 * Parse compact callback_data produced by buildApproveKeyboard.
 * Returns null if the data doesn't match the expected format.
 */
export function parseApproveCallback(
  data: string,
): { action: "approve"; executionIdPrefix: string; nodeIdPrefix: string } | null {
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const actionChar = parts[0];
  if (actionChar !== "a") return null;
  const execPrefix = parts[1];
  const nodePrefix = parts[2];
  if (!/^[a-f0-9-]{8}$/.test(execPrefix)) return null;
  if (!/^[a-zA-Z0-9_-]{1,12}$/.test(nodePrefix)) return null;
  return {
    action: "approve",
    executionIdPrefix: execPrefix,
    nodeIdPrefix: nodePrefix,
  };
}

/**
 * Utility type for creating Telegram notification node configurations
 * Used in workflow JSON definitions
 */
export interface TelegramNodeConfig {
  /** Message template with variable substitution support */
  message: string;
  /** Target chat ID (can be template variable) */
  chatId?: string;
  /** Message parsing mode for rich formatting */
  parseMode?: "Markdown" | "HTML";
  /** Send notification silently */
  disableNotification?: boolean;
  /** Optional inline keyboard markup */
  replyMarkup?: InlineKeyboardMarkup;
}
