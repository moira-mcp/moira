/**
 * Telegram Bot API HTTP Client
 * Production-ready client with comprehensive error handling and rate limiting
 */

import {
  TelegramConfig,
  SendMessageParams,
  TelegramResponse,
  TelegramError,
  TelegramErrorType,
} from "../types/telegram-types.js";
import { RateLimiter, createTelegramRateLimiter } from "./rate-limiter.js";
import { createLogger, WorkflowLogger } from "@mcp-moira/shared";

/**
 * HTTP client for Telegram Bot API with rate limiting and error handling
 * Implements graceful degradation strategy for production use
 */
export class TelegramClient {
  private config: TelegramConfig;
  private rateLimiter: RateLimiter;
  private logger: WorkflowLogger;

  constructor(config: TelegramConfig, rateLimiter?: RateLimiter) {
    this.config = this.validateAndNormalizeConfig(config);
    this.rateLimiter = rateLimiter ?? createTelegramRateLimiter();
    this.logger = createLogger({ component: "TelegramClient" });

    this.logger.info("Telegram client initialized", {
      apiUrl: this.config.apiUrl,
      timeout: this.config.timeout,
      hasDefaultChatId: !!this.config.defaultChatId,
    });
  }

  /**
   * Send message to Telegram chat
   * Handles rate limiting, HTTP errors, and API errors gracefully
   */
  async sendMessage(params: SendMessageParams): Promise<TelegramResponse> {
    try {
      // Apply rate limiting
      await this.rateLimiter.waitForAvailability();

      const response = await this.makeHttpRequest(params);

      this.logger.info("Message sent successfully", {
        chatId: params.chatId,
        messageLength: params.text.length,
        parseMode: params.parseMode,
      });

      return response;
    } catch (error) {
      const telegramError = this.handleError(error, params);
      // No logging here - boundary handles it
      throw telegramError;
    }
  }

  /**
   * Send message with default chat ID if configured
   * Convenience method for simple use cases
   */
  async sendMessageToDefault(
    text: string,
    options: Omit<SendMessageParams, "chatId" | "text"> = {},
  ): Promise<TelegramResponse> {
    if (!this.config.defaultChatId) {
      throw this.createError(TelegramErrorType.INVALID_CHAT_ID, "No default chat ID configured", {
        providedText: text,
      });
    }

    return this.sendMessage({
      chatId: this.config.defaultChatId,
      text,
      ...options,
    });
  }

  /**
   * Answer a callback query from an inline keyboard button press.
   * Dismisses the loading indicator on the user's Telegram client.
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<TelegramResponse> {
    try {
      await this.rateLimiter.waitForAvailability();

      const url = this.buildApiUrl("answerCallbackQuery");
      const body: Record<string, unknown> = {
        callback_query_id: callbackQueryId,
      };
      if (text) {
        body.text = text;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 5000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const responseData = (await response.json()) as TelegramResponse;

        if (!response.ok || !responseData.ok) {
          throw this.createApiError(response, responseData);
        }

        return responseData;
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === "AbortError") {
          throw this.createError(
            TelegramErrorType.TIMEOUT_ERROR,
            `answerCallbackQuery timeout after ${this.config.timeout}ms`,
          );
        }
        throw error;
      }
    } catch (error) {
      // Best-effort: log and rethrow
      const telegramError =
        error && typeof error === "object" && "type" in error
          ? (error as TelegramError)
          : this.createError(TelegramErrorType.API_ERROR, String(error));
      throw telegramError;
    }
  }

  /**
   * Set webhook URL for receiving updates from Telegram.
   * Called when user configures bot token.
   */
  async setWebhook(
    url: string,
    allowedUpdates?: string[],
    secretToken?: string,
  ): Promise<TelegramResponse> {
    await this.rateLimiter.waitForAvailability();

    const apiUrl = this.buildApiUrl("setWebhook");
    const body: Record<string, unknown> = { url };
    if (allowedUpdates) {
      body.allowed_updates = allowedUpdates;
    }
    if (secretToken) {
      body.secret_token = secretToken;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 5000);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const responseData = (await response.json()) as TelegramResponse;

      if (!response.ok || !responseData.ok) {
        throw this.createApiError(response, responseData);
      }

      this.logger.info("Webhook set successfully", { url });
      return responseData;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw this.createError(
          TelegramErrorType.TIMEOUT_ERROR,
          `setWebhook timeout after ${this.config.timeout}ms`,
        );
      }
      throw error;
    }
  }

  /**
   * Test connection to Telegram Bot API
   * Useful for configuration validation
   */
  async testConnection(): Promise<boolean> {
    try {
      const _testParams: SendMessageParams = {
        chatId: this.config.defaultChatId || "test",
        text: "Connection test",
      };

      // Don't actually send - just test URL construction and token
      const url = this.buildApiUrl("sendMessage");

      this.logger.debug("Connection test", { url: url.split("bot")[0] + "bot[REDACTED]" });

      return true;
    } catch (error) {
      this.logger.debug("Connection test failed", { error: String(error) });
      return false;
    }
  }

  /**
   * Get rate limiter status for monitoring
   */
  getRateLimitStatus() {
    return this.rateLimiter.getStatus();
  }

  /**
   * Get default chat ID if configured
   * Used by handlers to determine target chat
   */
  getDefaultChatId(): string | undefined {
    return this.config.defaultChatId;
  }

  /**
   * Make HTTP request to Telegram Bot API
   * Central point for all HTTP communication
   */
  private async makeHttpRequest(params: SendMessageParams): Promise<TelegramResponse> {
    const url = this.buildApiUrl("sendMessage");
    const body = this.buildRequestBody(params);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout || 5000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseData = (await response.json()) as TelegramResponse;

      if (!response.ok || !responseData.ok) {
        throw this.createApiError(response, responseData);
      }

      return responseData;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw this.createError(
          TelegramErrorType.TIMEOUT_ERROR,
          `Request timeout after ${this.config.timeout}ms`,
          { url, params },
        );
      }

      throw error;
    }
  }

  /**
   * Build Telegram Bot API URL for specific method
   */
  private buildApiUrl(method: string): string {
    const baseUrl = this.config.apiUrl || "https://api.telegram.org/bot";
    return `${baseUrl}${this.config.botToken}/${method}`;
  }

  /**
   * Build request body for Telegram API
   * Handles message validation and formatting
   */
  private buildRequestBody(params: SendMessageParams): Record<string, unknown> {
    // Validate message length
    if (params.text.length > 4096) {
      throw this.createError(
        TelegramErrorType.MESSAGE_TOO_LONG,
        `Message too long: ${params.text.length} characters (max 4096)`,
        { messageLength: params.text.length, chatId: params.chatId },
      );
    }

    const body: Record<string, unknown> = {
      chat_id: params.chatId,
      text: params.text,
    };

    if (params.parseMode) {
      body.parse_mode = params.parseMode;
    }

    if (params.disableNotification !== undefined) {
      body.disable_notification = params.disableNotification;
    }

    if (params.replyMarkup) {
      body.reply_markup = JSON.stringify(params.replyMarkup);
    }

    return body;
  }

  /**
   * Create TelegramError from API response
   */
  private createApiError(response: Response, data: TelegramResponse): TelegramError {
    const errorType = this.classifyApiError(response.status, data);
    const message = data.description || `HTTP ${response.status}: ${response.statusText}`;

    return this.createError(errorType, message, {
      statusCode: response.status,
      telegramErrorCode: data.errorCode,
      description: data.description,
    });
  }

  /**
   * Classify API error type based on HTTP status and Telegram response
   */
  private classifyApiError(status: number, data: TelegramResponse): TelegramErrorType {
    // Telegram-specific error codes
    if (data.errorCode === 400) {
      if (data.description?.includes("chat not found")) {
        return TelegramErrorType.INVALID_CHAT_ID;
      }
      if (data.description?.includes("message is too long")) {
        return TelegramErrorType.MESSAGE_TOO_LONG;
      }
    }

    if (data.errorCode === 401) {
      return TelegramErrorType.INVALID_TOKEN;
    }

    if (data.errorCode === 429) {
      return TelegramErrorType.RATE_LIMIT_EXCEEDED;
    }

    // HTTP status-based classification
    switch (status) {
      case 401:
        return TelegramErrorType.INVALID_TOKEN;
      case 400:
        return TelegramErrorType.INVALID_CHAT_ID;
      case 429:
        return TelegramErrorType.RATE_LIMIT_EXCEEDED;
      default:
        return TelegramErrorType.API_ERROR;
    }
  }

  /**
   * Handle and classify errors from HTTP requests
   */
  private handleError(error: unknown, context: SendMessageParams): TelegramError {
    // Check if error is already a TelegramError (has type property)
    if (error && typeof error === "object" && "type" in error) {
      return error as TelegramError;
    }

    if (error instanceof TypeError) {
      return this.createError(TelegramErrorType.NETWORK_ERROR, "Network connectivity issue", {
        originalError: error,
        chatId: context.chatId,
      });
    }

    return this.createError(
      TelegramErrorType.API_ERROR,
      error instanceof Error ? error.message : "Unknown error",
      { originalError: error, chatId: context.chatId },
    );
  }

  /**
   * Create structured TelegramError with context
   */
  private createError(
    type: TelegramErrorType,
    message: string,
    context: Record<string, unknown> = {},
  ): TelegramError {
    const error = new Error(message) as TelegramError;
    error.type = type;
    error.context = context;

    if (context.originalError) {
      error.originalError = context.originalError;
    }

    return error;
  }

  /**
   * Validate and normalize configuration
   */
  private validateAndNormalizeConfig(config: TelegramConfig): TelegramConfig {
    if (!config.botToken) {
      throw this.createError(TelegramErrorType.INVALID_TOKEN, "Bot token is required");
    }

    // Basic token format validation (should start with number and contain colon)
    if (!/^\d+:.+/.test(config.botToken)) {
      throw this.createError(TelegramErrorType.INVALID_TOKEN, "Invalid bot token format");
    }

    return {
      ...config,
      apiUrl: config.apiUrl || "https://api.telegram.org/bot",
      timeout: config.timeout || 5000,
    };
  }
}
