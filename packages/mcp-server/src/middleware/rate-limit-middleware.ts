/**
 * Rate Limiting Middleware for MCP Server
 * Protection against abuse: 1000 requests per minute
 *
 * Supports bypass via X-Load-Test header for load testing.
 * Header value must match LOAD_TEST_SECRET environment variable.
 * Note: X-Load-Test header is also used for authentication bypass,
 * providing a unified load testing mechanism.
 */

import rateLimit from "express-rate-limit";
import type { Request } from "express";
import {
  isTestEnvironment,
  isRateLimitDisabled,
  getLoadTestSecret,
  createLogger,
} from "@mcp-moira/shared";

const logger = createLogger({ component: "mcp-rate-limit" });

// Disable rate limiting in test environment or when explicitly disabled via env
const skipRateLimit = isTestEnvironment() || isRateLimitDisabled();

// Load test header name (unified for both auth and rate limit bypass)
const LOAD_TEST_HEADER = "x-load-test";

/**
 * Check if request has valid load test header
 * Returns true if header matches LOAD_TEST_SECRET env var
 */
function hasValidLoadTestHeader(req: Request): boolean {
  const secret = getLoadTestSecret();
  if (!secret) return false;

  const headerValue = req.headers[LOAD_TEST_HEADER];
  if (!headerValue || typeof headerValue !== "string") return false;

  const isValid = headerValue === secret;
  if (isValid) {
    logger.debug("Rate limit bypassed via load test header", {
      type: "rate_limit_bypass",
      ip: req.ip,
      path: req.path,
      method: req.method,
    });
  }
  return isValid;
}

/**
 * MCP endpoints rate limiter: 1000 requests per minute
 * High limit to support parallel test execution and legitimate heavy use
 * Still protects against DoS (16 req/sec burst)
 */
export const mcpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000,
  skip: (req) => skipRateLimit || hasValidLoadTestHeader(req),
  message: "Too many MCP requests, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});
