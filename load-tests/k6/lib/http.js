/**
 * k6 HTTP Helper Functions
 *
 * Reusable HTTP request helpers with proper error handling,
 * metrics tagging, and response validation.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import { getApiUrl, httpDefaults } from "./config.js";

/**
 * Custom metrics for tracking across scenarios
 */
export const customMetrics = {
  errors: new Rate("errors"),
  apiDuration: new Trend("api_duration", true),
};

/**
 * Standard response checks
 * @param {Object} response - k6 response object
 * @param {number} expectedStatus - Expected HTTP status (default 200)
 * @returns {boolean} True if all checks pass
 */
export function checkResponse(response, expectedStatus = 200) {
  const checks = check(response, {
    [`status is ${expectedStatus}`]: (r) => r.status === expectedStatus,
    "response time < 2s": (r) => r.timings.duration < 2000,
    "no server errors": (r) => r.status < 500,
  });

  // Track errors
  if (!checks) {
    customMetrics.errors.add(1);
  } else {
    customMetrics.errors.add(0);
  }

  // Track duration
  customMetrics.apiDuration.add(response.timings.duration);

  return checks;
}

/**
 * Check JSON response has expected structure
 * @param {Object} response - k6 response object
 * @param {Array<string>} requiredFields - Fields that must be present
 * @returns {boolean} True if all fields present
 */
export function checkJsonResponse(response, requiredFields = []) {
  try {
    const body = JSON.parse(response.body);

    const fieldChecks = {};
    for (const field of requiredFields) {
      fieldChecks[`has ${field}`] = () => body[field] !== undefined;
    }

    return check(response, fieldChecks);
  } catch (_e) {
    return check(response, {
      "valid JSON": () => false,
    });
  }
}

/**
 * Parse JSON response body safely
 * @param {Object} response - k6 response object
 * @returns {Object|null} Parsed body or null
 */
export function parseJsonBody(response) {
  try {
    return JSON.parse(response.body);
  } catch (_e) {
    console.warn(
      "Failed to parse JSON: " + (response.body ? response.body.substring(0, 100) : "empty"),
    );
    return null;
  }
}

/**
 * Merge params with defaults (k6-compatible, no spread operator)
 */
function mergeParams(defaults, extra) {
  var result = { headers: defaults.headers };
  for (var key in extra) {
    result[key] = extra[key];
  }
  return result;
}

/**
 * Make GET request to API endpoint
 * @param {string} endpoint - API endpoint path (without /api prefix)
 * @param {Object} params - Additional k6 params
 * @returns {Object} k6 response
 */
export function apiGet(endpoint, params) {
  params = params || {};
  var url = getApiUrl() + endpoint;
  return http.get(url, mergeParams(httpDefaults, params));
}

/**
 * Make POST request to API endpoint
 * @param {string} endpoint - API endpoint path
 * @param {Object} body - Request body
 * @param {Object} params - Additional k6 params
 * @returns {Object} k6 response
 */
export function apiPost(endpoint, body, params) {
  params = params || {};
  var url = getApiUrl() + endpoint;
  return http.post(url, JSON.stringify(body), mergeParams(httpDefaults, params));
}

/**
 * Make authenticated GET request
 * @param {string} endpoint - API endpoint path
 * @param {Object} cookies - Session cookies
 * @param {Object} params - Additional k6 params
 * @returns {Object} k6 response
 */
export function apiGetAuth(endpoint, cookies, params) {
  params = params || {};
  var url = getApiUrl() + endpoint;
  var opts = mergeParams(httpDefaults, params);
  opts.cookies = cookies;
  return http.get(url, opts);
}

/**
 * Make authenticated POST request
 * @param {string} endpoint - API endpoint path
 * @param {Object} body - Request body
 * @param {Object} cookies - Session cookies
 * @param {Object} params - Additional k6 params
 * @returns {Object} k6 response
 */
export function apiPostAuth(endpoint, body, cookies, params) {
  params = params || {};
  var url = getApiUrl() + endpoint;
  var opts = mergeParams(httpDefaults, params);
  opts.cookies = cookies;
  return http.post(url, JSON.stringify(body), opts);
}

/**
 * Make batch requests (parallel)
 * @param {Array} requests - Array of request configs
 * @returns {Array} Array of responses
 */
export function apiBatch(requests) {
  const apiUrl = getApiUrl();
  const batchRequests = requests.map((req) => ({
    method: req.method || "GET",
    url: `${apiUrl}${req.endpoint}`,
    body: req.body ? JSON.stringify(req.body) : null,
    params: {
      headers: httpDefaults.headers,
      cookies: req.cookies || {},
      tags: req.tags || {},
    },
  }));

  return http.batch(batchRequests);
}

/**
 * Sleep with random jitter to avoid thundering herd
 * @param {number} baseMs - Base sleep time in ms
 * @param {number} jitterMs - Random jitter range in ms
 */
export function sleepWithJitter(baseMs, jitterMs = 100) {
  const jitter = Math.random() * jitterMs;
  sleep((baseMs + jitter) / 1000);
}

/**
 * Random sleep between requests to simulate real user
 * @param {number} minMs - Minimum sleep in ms
 * @param {number} maxMs - Maximum sleep in ms
 */
export function randomSleep(minMs = 100, maxMs = 500) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  sleep(ms / 1000);
}

/**
 * Format response for logging
 * @param {Object} response - k6 response
 * @returns {string} Formatted string
 */
export function formatResponse(response) {
  return `${response.status} ${response.timings.duration.toFixed(0)}ms`;
}

/**
 * Log request result
 * @param {string} name - Request name
 * @param {Object} response - k6 response
 */
export function logRequest(name, response) {
  const status = response.status;
  const duration = response.timings.duration.toFixed(0);
  const statusEmoji = status >= 200 && status < 300 ? "✓" : "✗";
  console.log(`${statusEmoji} ${name}: ${status} (${duration}ms)`);
}
