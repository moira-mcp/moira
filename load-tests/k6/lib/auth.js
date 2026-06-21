/**
 * k6 Authentication Helper for Load Testing
 *
 * Implements secure load testing authentication using special domain:
 * - Uses `load-testing-noverify.local` email domain
 * - Requires X-Load-Test header with secret from LOAD_TEST_SECRET env var
 * - Backend bypasses email verification for these requests
 *
 * This approach:
 * - ✅ No dev-login endpoint exposure
 * - ✅ Works in CI/automated contexts
 * - ✅ Requires secret for abuse prevention
 * - ✅ Auto-cleanup removes test users periodically
 */

import http from "k6/http";
import { check } from "k6";
import { getApiUrl, httpDefaults } from "./config.js";

// Load testing domain - bypasses email verification when used with correct header
const LOAD_TEST_DOMAIN = "load-testing-noverify.local";

// Load test secret from environment
const LOAD_TEST_SECRET = __ENV.LOAD_TEST_SECRET || "";

/**
 * Generate unique test user email for this VU
 * @param {string} suffix - Optional suffix to make email unique
 * @returns {string} Unique test user email
 */
export function generateTestEmail(suffix = null) {
  const timestamp = Date.now();
  // __VU and __ITER are not available in setup(), use 0 as fallback
  const vuId = typeof __VU !== "undefined" ? __VU : 0;
  const uniqueSuffix = suffix || Math.random().toString(36).substring(2, 8);
  return `loadtest-${timestamp}-vu${vuId}-${uniqueSuffix}@${LOAD_TEST_DOMAIN}`;
}

/**
 * Generate test user password
 * @returns {string} Test password
 */
export function generateTestPassword() {
  return "LoadTest123!";
}

/**
 * Get headers required for load testing authentication
 * @returns {Object} Headers with load test secret
 */
export function getLoadTestHeaders() {
  // Note: k6's goja engine doesn't support spread operator
  return {
    "Content-Type": httpDefaults.headers["Content-Type"],
    Accept: httpDefaults.headers["Accept"],
    "X-Load-Test": LOAD_TEST_SECRET,
  };
}

/**
 * Register a new test user for load testing
 * Uses special domain that bypasses email verification
 *
 * @param {string} email - Test user email
 * @param {string} password - Test user password
 * @returns {Object|null} User data with session cookies, or null on failure
 */
export function registerTestUser(email = null, password = null) {
  const testEmail = email || generateTestEmail();
  const testPassword = password || generateTestPassword();
  const apiUrl = getApiUrl();
  const vuId = typeof __VU !== "undefined" ? __VU : 0;

  const payload = JSON.stringify({
    email: testEmail,
    password: testPassword,
    name: `Load Test User ${vuId}`,
    acceptedTermsAt: new Date().toISOString(),
    acceptedNotRussianResidentAt: new Date().toISOString(),
  });

  const response = http.post(`${apiUrl}/auth/sign-up/email`, payload, {
    headers: getLoadTestHeaders(),
    tags: { name: "auth_register" },
  });

  const success = check(response, {
    "registration status is 200": (r) => r.status === 200,
    "registration has user": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.user !== undefined;
      } catch (_e) {
        return false;
      }
    },
  });

  if (!success) {
    console.warn(`Registration failed: ${response.status} - ${response.body}`);
    return null;
  }

  try {
    const body = JSON.parse(response.body);
    return {
      user: body.user,
      cookies: response.cookies,
      email: testEmail,
      password: testPassword,
    };
  } catch (_e) {
    console.warn("Failed to parse registration response");
    return null;
  }
}

/**
 * Login with existing test user credentials
 *
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Object|null} Session data with cookies, or null on failure
 */
export function loginTestUser(email, password) {
  const apiUrl = getApiUrl();

  const payload = JSON.stringify({
    email,
    password,
  });

  const response = http.post(`${apiUrl}/auth/sign-in/email`, payload, {
    headers: getLoadTestHeaders(),
    tags: { name: "auth_login" },
  });

  const success = check(response, {
    "login status is 200": (r) => r.status === 200,
    "login has session": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.session !== undefined;
      } catch (_e) {
        return false;
      }
    },
  });

  if (!success) {
    console.warn(`Login failed: ${response.status} - ${response.body}`);
    return null;
  }

  try {
    const body = JSON.parse(response.body);
    return {
      session: body.session,
      user: body.user,
      cookies: response.cookies,
    };
  } catch (_e) {
    console.warn("Failed to parse login response");
    return null;
  }
}

/**
 * Create or get test user session for a VU
 * Tries to login first, registers if that fails
 *
 * @returns {Object|null} Session with auth data, or null on failure
 */
export function getOrCreateTestSession() {
  // First try to register (which also logs in due to autoSignIn)
  const registration = registerTestUser();
  if (registration) {
    return registration;
  }

  // Registration failed - this VU might have already registered
  // Try to login instead
  const email = generateTestEmail();
  const password = generateTestPassword();
  return loginTestUser(email, password);
}

/**
 * Convert k6 response cookies to simple {name: value} format
 * k6 returns cookies as {name: [{value, ...}]} but expects {name: value} in params
 *
 * @param {Object} responseCookies - Cookies from response.cookies
 * @returns {Object} Simple cookie object for k6 params
 */
export function simpleCookies(responseCookies) {
  var simple = {};
  for (var name in responseCookies) {
    var cookieArr = responseCookies[name];
    if (cookieArr && cookieArr.length > 0) {
      simple[name] = cookieArr[0].value;
    }
  }
  return simple;
}

/**
 * Make authenticated HTTP request with session cookies
 *
 * @param {string} method - HTTP method
 * @param {string} url - Request URL
 * @param {Object} body - Request body (optional)
 * @param {Object} cookies - Session cookies from login/register (k6 response.cookies format)
 * @param {Object} extraParams - Extra k6 http params
 * @returns {Object} k6 response
 */
export function authenticatedRequest(method, url, body, cookies, extraParams) {
  body = body || null;
  cookies = cookies || {};
  extraParams = extraParams || {};

  // Convert cookies from k6 response format to simple {name: value}
  var simplifiedCookies = simpleCookies(cookies);

  // Build headers with load test secret for rate limit bypass
  var headers = {};
  for (var key in httpDefaults.headers) {
    headers[key] = httpDefaults.headers[key];
  }
  // Add load test header for rate limit bypass
  if (LOAD_TEST_SECRET && LOAD_TEST_SECRET.length > 0) {
    headers["X-Load-Test"] = LOAD_TEST_SECRET;
  }
  if (extraParams.headers) {
    for (var hkey in extraParams.headers) {
      headers[hkey] = extraParams.headers[hkey];
    }
  }

  // Build params without spread operator
  var params = {
    headers: headers,
    cookies: simplifiedCookies,
  };
  for (var pkey in extraParams) {
    if (pkey !== "headers") {
      params[pkey] = extraParams[pkey];
    }
  }

  if (method === "GET" || method === "DELETE") {
    return http.request(method, url, null, params);
  } else {
    var payload = body ? JSON.stringify(body) : null;
    return http.request(method, url, payload, params);
  }
}

/**
 * Make authenticated GET request
 */
export function authGet(url, cookies, params = {}) {
  return authenticatedRequest("GET", url, null, cookies, params);
}

/**
 * Make authenticated POST request
 */
export function authPost(url, body, cookies, params = {}) {
  return authenticatedRequest("POST", url, body, cookies, params);
}

/**
 * Make authenticated PUT request
 */
export function authPut(url, body, cookies, params = {}) {
  return authenticatedRequest("PUT", url, body, cookies, params);
}

/**
 * Make authenticated DELETE request
 */
export function authDelete(url, cookies, params = {}) {
  return authenticatedRequest("DELETE", url, null, cookies, params);
}

/**
 * Check if load test secret is configured
 * @returns {boolean} True if secret is set
 */
export function isLoadTestSecretConfigured() {
  return LOAD_TEST_SECRET && LOAD_TEST_SECRET.length > 0;
}

/**
 * Validate load test environment
 * Call in setup() to ensure configuration is correct
 */
export function validateLoadTestEnvironment() {
  if (!isLoadTestSecretConfigured()) {
    console.warn("⚠️  LOAD_TEST_SECRET not set - authentication will fail");
    console.warn("   Set LOAD_TEST_SECRET environment variable to enable test user registration");
    return false;
  }

  // Try a test registration to validate backend is configured
  const testEmail = `validate-${Date.now()}@${LOAD_TEST_DOMAIN}`;
  const apiUrl = getApiUrl();

  const response = http.post(
    `${apiUrl}/auth/sign-up/email`,
    JSON.stringify({
      email: testEmail,
      password: generateTestPassword(),
      name: "Validation Test",
      acceptedTermsAt: new Date().toISOString(),
      acceptedNotRussianResidentAt: new Date().toISOString(),
    }),
    { headers: getLoadTestHeaders() },
  );

  if (response.status !== 200) {
    console.warn(`⚠️  Load test environment validation failed: ${response.status}`);
    console.warn(`   Response: ${response.body}`);
    return false;
  }

  console.log("✅ Load test environment validated successfully");
  return true;
}
