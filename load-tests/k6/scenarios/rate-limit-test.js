/**
 * k6 Rate Limit Verification Scenario
 *
 * Tests that rate limiting works correctly when bypass header is NOT used.
 * This scenario intentionally triggers rate limits to verify server protection.
 *
 * IMPORTANT: This scenario requires:
 *   1. Target server has rate limiting ENABLED (DISABLE_RATE_LIMIT != true)
 *   2. k6 client has DISABLE_RATE_BYPASS=true to prevent bypass header
 *
 * The public /api/features route is mounted with the ordinary API limiter:
 * 100 requests per client address per minute. Health is a separate unlimited probe.
 *
 * Usage (against staging with rate limiting enabled):
 *   docker compose -f docker-compose.k6.yml --profile run run --rm \
 *     -e TARGET_BASE_URL=https://staging.example.com \
 *     -e DISABLE_RATE_BYPASS=true \
 *     k6 run /scripts/scenarios/rate-limit-test.js
 *
 * Use an explicitly selected test target with rate limiting enabled and no
 * whitelist/test-mode bypass for the requesting address.
 *
 * Environment variables:
 *   TARGET_BASE_URL - Base URL of target system (with rate limiting enabled)
 *   DISABLE_RATE_BYPASS - Must be "true" to test rate limiting
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter, Trend } from "k6/metrics";
import { getBaseUrl, getApiUrl, rateLimitBypass } from "../lib/index.js";

// Custom metrics
const rateLimitHits = new Counter("rate_limit_hits");
const rateLimitMisses = new Counter("rate_limit_misses");
const rateLimitRate = new Rate("rate_limit_rate");
const requestDuration = new Trend("request_duration", true);

// Rate limit test configuration
// Uses constant-arrival-rate to send requests at controlled rate
export const options = {
  scenarios: {
    // Test API rate limit (100/min) - send 150 req in ~10 seconds
    api_rate_limit: {
      executor: "constant-arrival-rate",
      rate: 15, // 15 requests per timeUnit
      timeUnit: "1s",
      duration: "10s", // Total ~150 requests
      preAllocatedVUs: 20,
      maxVUs: 50,
      exec: "testApiRateLimit",
      tags: { endpoint: "api" },
    },
  },
  thresholds: {
    checks: ["rate==1"], // Unexpected statuses or malformed 429 responses fail the run.
    // We EXPECT rate limits to be hit - this is the test
    rate_limit_hits: ["count>=1"], // Must hit at least 1 rate limit
    rate_limit_rate: ["rate>0"], // Must have some rate limited requests
    // Response time should still be reasonable
    request_duration: ["p(95)<1000"],
  },
  tags: {
    scenario: "rate_limit_test",
  },
};

/**
 * Setup - verify bypass is disabled
 */
export function setup() {
  var apiUrl = getApiUrl();

  console.log("=== k6 Rate Limit Verification Scenario ===");
  console.log("Target: " + getBaseUrl());
  console.log("API URL: " + apiUrl);
  console.log("");

  // CRITICAL: Verify bypass is disabled
  if (rateLimitBypass.enabled) {
    throw new Error(
      "Rate limit bypass is ENABLED! This test requires DISABLE_RATE_BYPASS=true. " +
        "Set environment variable: -e DISABLE_RATE_BYPASS=true",
    );
  }
  console.log("Rate limit bypass: DISABLED (correct for this test)");
  console.log("");

  // Verify target is reachable
  var res = http.get(apiUrl + "/health", { timeout: "10s" });
  if (res.status !== 200) {
    throw new Error("Target not reachable: " + apiUrl + " returned " + res.status);
  }
  console.log("Target is reachable");
  console.log("");

  console.log("Expected /api/features limit: 100 requests per client address per minute");
  console.log("");
  console.log("This test will exceed API limit to verify 429 responses.");

  return {
    apiUrl: apiUrl,
    startTime: Date.now(),
  };
}

/**
 * Test the mounted API limiter through the public features route.
 * No authentication is needed; a health response cannot establish this quota.
 */
export function testApiRateLimit(data) {
  var apiUrl = data.apiUrl;

  // Make request WITHOUT bypass header
  var res = http.get(apiUrl + "/features", {
    headers: {
      Accept: "application/json",
      // Intentionally NO X-Load-Test header (testing rate limit enforcement)
    },
    tags: { name: "api_features" },
  });

  requestDuration.add(res.timings.duration);

  // Check for rate limiting
  if (res.status === 429) {
    rateLimitHits.add(1);
    rateLimitRate.add(1);

    check(res, {
      "rate limit response has error message": function (r) {
        try {
          var body = JSON.parse(r.body);
          return body.error && body.error.includes("Too many");
        } catch (_e) {
          return false;
        }
      },
      "rate limit has Retry-After header": function (r) {
        return r.headers["Retry-After"] !== undefined || r.headers["RateLimit-Reset"] !== undefined;
      },
    });
  } else {
    rateLimitMisses.add(1);
    rateLimitRate.add(0);

    check(res, {
      "successful response": function (r) {
        return r.status === 200;
      },
    });
  }

  // Minimal sleep to maximize request rate
  sleep(0.01);
}

/**
 * Default function - required by k6 but not used with named scenarios
 */
export default function () {
  // The scenario selects the named testApiRateLimit function.
  // The default function is not used but k6 requires it to exist
}

/**
 * Teardown - report results
 */
export function teardown(data) {
  var duration = (Date.now() - data.startTime) / 1000;

  console.log("");
  console.log("=== Rate Limit Test Summary ===");
  console.log("Duration: " + duration.toFixed(1) + " seconds");
  console.log("");
  console.log("Check metrics for:");
  console.log("  - rate_limit_hits: Number of 429 responses received");
  console.log("  - rate_limit_rate: Percentage of requests that were rate limited");
  console.log("");
  console.log("SUCCESS criteria: rate_limit_hits >= 1");
  console.log("Acceptance is determined by the actual k6 checks and thresholds above.");
}
