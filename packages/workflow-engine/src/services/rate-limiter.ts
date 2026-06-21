/**
 * Simple Rate Limiter for Telegram Bot API
 * Implements token bucket algorithm for production-ready traffic control
 */

import { RateLimiterConfig, RateLimiterState, RateLimitResult } from "../types/telegram-types.js";
import { createLogger, WorkflowLogger } from "@mcp-moira/shared";

/**
 * Simple rate limiter implementing token bucket algorithm
 * Designed for Telegram Bot API limits (30 requests per minute)
 */
export class RateLimiter {
  private config: RateLimiterConfig;
  private state: RateLimiterState;
  private logger: WorkflowLogger;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = {
      maxRequests: config.maxRequests ?? 30, // Telegram Bot API default limit
      timeWindow: config.timeWindow ?? 60000, // 1 minute in milliseconds
    };

    this.state = {
      requestTimestamps: [],
      lastCleanup: Date.now(),
    };

    this.logger = createLogger({ component: "RateLimiter" });

    this.logger.debug("Rate limiter initialized", {
      maxRequests: this.config.maxRequests,
      timeWindow: this.config.timeWindow,
    });
  }

  /**
   * Check if request is allowed under rate limit
   * Returns immediately with allow/deny decision
   */
  async checkLimit(): Promise<RateLimitResult> {
    const now = Date.now();

    // Clean up old timestamps periodically
    this.cleanupOldTimestamps(now);

    const currentCount = this.state.requestTimestamps.length;

    if (currentCount >= this.config.maxRequests) {
      const oldestRequest = this.state.requestTimestamps[0];
      const retryAfter = Math.max(0, oldestRequest + this.config.timeWindow - now);

      this.logger.debug("Rate limit exceeded", {
        currentCount,
        maxRequests: this.config.maxRequests,
        retryAfter,
      });

      return {
        allowed: false,
        retryAfter,
        currentCount,
      };
    }

    // Record this request
    this.state.requestTimestamps.push(now);

    this.logger.debug("Request allowed", {
      currentCount: currentCount + 1,
      maxRequests: this.config.maxRequests,
    });

    return {
      allowed: true,
      currentCount: currentCount + 1,
    };
  }

  /**
   * Wait until rate limit allows next request
   * Promise resolves when request can be made
   */
  async waitForAvailability(): Promise<void> {
    const result = await this.checkLimit();

    if (result.allowed) {
      return;
    }

    if (result.retryAfter && result.retryAfter > 0) {
      this.logger.info("Waiting for rate limit reset", {
        waitTime: result.retryAfter,
      });

      await new Promise((resolve) => setTimeout(resolve, result.retryAfter));

      // Recursively check again after waiting
      return this.waitForAvailability();
    }
  }

  /**
   * Get current rate limiting status
   * Useful for monitoring and debugging
   */
  getStatus(): {
    currentCount: number;
    maxRequests: number;
    timeWindow: number;
    nextResetTime: number | null;
  } {
    this.cleanupOldTimestamps(Date.now());

    const currentCount = this.state.requestTimestamps.length;
    const nextResetTime =
      currentCount > 0 ? this.state.requestTimestamps[0] + this.config.timeWindow : null;

    return {
      currentCount,
      maxRequests: this.config.maxRequests,
      timeWindow: this.config.timeWindow,
      nextResetTime,
    };
  }

  /**
   * Reset rate limiter state
   * Useful for testing or manual intervention
   */
  reset(): void {
    this.state.requestTimestamps = [];
    this.state.lastCleanup = Date.now();

    this.logger.info("Rate limiter reset");
  }

  /**
   * Clean up timestamps outside the current time window
   * Maintains efficiency by removing old data
   */
  private cleanupOldTimestamps(now: number): void {
    // Only cleanup periodically to avoid overhead
    // Use dynamic interval: minimum of 5s or the configured timeWindow
    const cleanupInterval = Math.min(5000, this.config.timeWindow);
    if (now - this.state.lastCleanup < cleanupInterval) {
      return;
    }

    const cutoff = now - this.config.timeWindow;
    const initialCount = this.state.requestTimestamps.length;

    this.state.requestTimestamps = this.state.requestTimestamps.filter(
      (timestamp) => timestamp > cutoff,
    );

    this.state.lastCleanup = now;

    const cleanedCount = initialCount - this.state.requestTimestamps.length;
    if (cleanedCount > 0) {
      this.logger.debug("Cleaned up old timestamps", {
        removed: cleanedCount,
        remaining: this.state.requestTimestamps.length,
      });
    }
  }
}

/**
 * Create a rate limiter with default Telegram Bot API settings
 */
export function createTelegramRateLimiter(config?: Partial<RateLimiterConfig>): RateLimiter {
  return new RateLimiter({
    maxRequests: 30, // Telegram Bot API limit
    timeWindow: 60000, // 1 minute
    ...config,
  });
}
