/**
 * Rate Limiting Middleware
 * Protection against abuse with different limits for API, Auth, and MCP endpoints
 *
 * Supports bypass via X-Load-Test header for load testing.
 * Header value must match LOAD_TEST_SECRET environment variable.
 * Note: X-Load-Test header is also used for authentication bypass,
 * providing a unified load testing mechanism.
 */

import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import { logger } from "../utils/logger.js";
import {
  isTestEnvironment,
  isRateLimitDisabled,
  getRateLimitWhitelist,
  getLoadTestSecret,
} from "@mcp-moira/shared";
// Imported from the deep ./urls subpath rather than the package barrel: the
// jest ESM linker does not reliably surface names re-exported through nested
// `export *` chains, and this matches how other consumers import url helpers.
import { resolveArtifactUuidFromHost } from "@mcp-moira/shared/urls";

// Disable rate limiting in test environment or when explicitly disabled
const isTestEnv = isTestEnvironment() || isRateLimitDisabled();

// IP whitelist from env (comma-separated)
const whitelist = getRateLimitWhitelist();

// Load test header name (unified for both auth and rate limit bypass)
const LOAD_TEST_HEADER = "x-load-test";

/**
 * Check if request IP is whitelisted
 */
function isWhitelisted(req: Request): boolean {
  if (whitelist.length === 0) return false;
  const ip = req.ip || req.socket.remoteAddress || "";
  // Handle IPv6-mapped IPv4 (::ffff:192.168.1.1)
  const normalizedIp = ip.replace(/^::ffff:/, "");
  return whitelist.includes(normalizedIp) || whitelist.includes(ip);
}

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
 * API endpoints rate limiter: 100 requests per minute
 * Applied to /api/* routes (except auth)
 * Disabled in test environment
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  skip: (req) => isTestEnv || isWhitelisted(req) || hasValidLoadTestHeader(req),
  message: "Too many API requests, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Rate limit exceeded", {
      type: "rate_limit_exceeded",
      limiter: "api",
      ip: req.ip,
      path: req.path,
      method: req.method,
    });
    res.status(429).json({ error: "Too many API requests, please try again later" });
  },
});

/**
 * Authentication endpoints rate limiter: 1000 requests per minute
 * Applied to /api/auth/* routes
 * High limit to support OAuth flows, parallel test execution, and legitimate use
 * Still protects against brute-force attacks (16 req/sec burst)
 */
export const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000,
  skip: (req) => isTestEnv || isWhitelisted(req) || hasValidLoadTestHeader(req),
  message: "Too many authentication requests, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Rate limit exceeded", {
      type: "rate_limit_exceeded",
      limiter: "auth",
      ip: req.ip,
      path: req.path,
      method: req.method,
    });
    res.status(429).json({ error: "Too many authentication requests, please try again later" });
  },
});

/**
 * Per-artifact view rate limiter: 120 views per minute PER ARTIFACT.
 *
 * Keyed by artifact uuid resolved from the REQUEST (see artifactKeyFromRequest),
 * not by client IP — this caps how often any single artifact can be served so a
 * malicious artifact cannot be distributed at abusive volume from Moira's
 * domain, while normal artifacts (viewed by many distinct users) are unaffected.
 * Falls back to IP keying if no uuid is derivable.
 */

/**
 * Resolve the artifact uuid for rate-limit keying directly from the request.
 *
 * This MUST be derived from the request alone (not res.locals), because the
 * keyGenerator runs as part of the limiter middleware — before the route
 * handler body executes — so any value the handler sets later is not yet
 * available here. Source order: per-artifact subdomain ({uuid}.{static-domain})
 * → path params (/static/__frame/:uuid, /static/__report/:uuid).
 */
export function artifactKeyFromRequest(req: Request): string | null {
  const fromHost = resolveArtifactUuidFromHost(req.headers.host);
  if (fromHost) return fromHost;

  // Route params (when matched), e.g. /__frame/:uuid, /__report/:uuid
  const param = (req.params as { uuid?: string } | undefined)?.uuid;
  if (param && param.length >= 10) return param;

  return null;
}

export const artifactViewLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  skip: (req) => isTestEnv || isWhitelisted(req) || hasValidLoadTestHeader(req),
  keyGenerator: (req) => {
    const uuid = artifactKeyFromRequest(req);
    // Fall back to IP keying through ipKeyGenerator, which normalizes IPv6
    // addresses to their /64 subnet. Using the raw req.ip as a key triggers
    // express-rate-limit's ERR_ERL_KEY_GEN_IPV6 validation error for IPv6
    // clients.
    return uuid ? `artifact:${uuid}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
  message: "This artifact is being requested too frequently. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Rate limit exceeded", {
      type: "rate_limit_exceeded",
      limiter: "artifact-view",
      artifactUuid: artifactKeyFromRequest(req),
      ip: req.ip,
      path: req.path,
      method: req.method,
    });
    res
      .status(429)
      .send(
        '<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>Too many requests</h1><p>This artifact is being requested too frequently. Please try again later.</p></body></html>',
      );
  },
});

/**
 * MCP endpoints rate limiter: 30 requests per minute
 * Applied to /mcp route
 */
export const mcpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  skip: (req) => isTestEnv || isWhitelisted(req) || hasValidLoadTestHeader(req),
  message: "Too many MCP requests, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn("Rate limit exceeded", {
      type: "rate_limit_exceeded",
      limiter: "mcp",
      ip: req.ip,
      path: req.path,
      method: req.method,
    });
    res.status(429).json({ error: "Too many MCP requests, please try again later" });
  },
});
