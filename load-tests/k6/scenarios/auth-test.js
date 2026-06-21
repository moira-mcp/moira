/**
 * k6 Authentication Test Scenario
 *
 * Validates that load test authentication works correctly:
 * 1. Registers test user with special domain
 * 2. Makes authenticated API call
 * 3. Verifies response
 *
 * Usage:
 *   docker compose -f docker-compose.k6.yml run --rm \
 *     -e TARGET_BASE_URL=http://host.docker.internal:3032 \
 *     -e LOAD_TEST_SECRET=your-secret-here \
 *     k6 run /scripts/scenarios/auth-test.js
 */

import { check } from "k6";
import http from "k6/http";
import { Rate, Trend } from "k6/metrics";
import {
  getBaseUrl,
  getApiUrl,
  registerTestUser,
  authGet,
  isLoadTestSecretConfigured,
  validateLoadTestEnvironment,
} from "../lib/index.js";

// Custom metrics
const errors = new Rate("errors");
const authDuration = new Trend("auth_duration", true);

// Test configuration
export const options = {
  scenarios: {
    auth_test: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(50)<100", "p(95)<250", "p(99)<500"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.01"],
    auth_duration: ["p(95)<3000"],
  },
};

/**
 * Setup function - runs once before test
 * Validates environment configuration
 */
export function setup() {
  console.log("=== k6 Authentication Test ===");
  console.log(`Target: ${getBaseUrl()}`);
  console.log(`Load test secret configured: ${isLoadTestSecretConfigured()}`);

  // Check if target is reachable
  const healthResponse = http.get(`${getApiUrl()}/health`, {
    timeout: "10s",
  });

  if (healthResponse.status !== 200) {
    throw new Error(`Target not reachable: ${healthResponse.status}`);
  }

  console.log("✅ Target is reachable");

  // Validate load test environment if secret is configured
  if (isLoadTestSecretConfigured()) {
    const valid = validateLoadTestEnvironment();
    if (!valid) {
      console.warn("⚠️  Load test environment validation failed");
      console.warn("   Backend may not be configured to accept load test users");
    }
  }

  return {
    startTime: Date.now(),
    apiUrl: getApiUrl(),
  };
}

/**
 * Main test function
 */
export default function (_data) {
  const startTime = Date.now();

  // Step 1: Register test user
  console.log("Step 1: Registering test user...");
  const session = registerTestUser();

  if (!session) {
    console.error("❌ Registration failed");
    errors.add(1);
    return;
  }

  console.log(`✅ Registered: ${session.email}`);

  // Step 2: Make authenticated request
  console.log("Step 2: Making authenticated request...");
  var apiUrl = getApiUrl();
  const userResponse = authGet(apiUrl + "/user/me", session.cookies, {
    tags: { name: "user_me" },
  });

  const userSuccess = check(userResponse, {
    "user/me status is 200": (r) => r.status === 200,
    "user/me has user data": (r) => {
      try {
        const body = JSON.parse(r.body);
        // API returns {success: true, data: {id, email, ...}}
        return body.success === true && body.data !== undefined;
      } catch (_e) {
        return false;
      }
    },
    "email matches": (r) => {
      try {
        const body = JSON.parse(r.body);
        // API returns user data in body.data, not body.user
        return body.data && body.data.email === session.email;
      } catch (_e) {
        return false;
      }
    },
  });

  if (!userSuccess) {
    console.error(`❌ User request failed: ${userResponse.status}`);
    console.error(`   Response: ${userResponse.body}`);
    errors.add(1);
    return;
  }

  console.log("✅ Authenticated request successful");

  // Step 3: Test workflows endpoint (requires auth)
  console.log("Step 3: Testing authenticated workflows endpoint...");
  const workflowsResponse = authGet(apiUrl + "/workflows?limit=5", session.cookies, {
    tags: { name: "workflows_list" },
  });

  const workflowsSuccess = check(workflowsResponse, {
    "workflows status is 200": (r) => r.status === 200,
    "workflows has data": (r) => {
      try {
        const body = JSON.parse(r.body);
        // API returns {success: true, data: {workflows: [...]}}
        return body.success === true && body.data && Array.isArray(body.data.workflows);
      } catch (_e) {
        return false;
      }
    },
  });

  if (!workflowsSuccess) {
    console.error(`❌ Workflows request failed: ${workflowsResponse.status}`);
    errors.add(1);
  } else {
    console.log("✅ Workflows endpoint accessible");
  }

  // Record auth test duration
  const duration = Date.now() - startTime;
  authDuration.add(duration);

  errors.add(0);
  console.log(`\n✅ Auth test completed in ${duration}ms`);
}

/**
 * Teardown function - runs once after test
 */
export function teardown(data) {
  const totalDuration = Date.now() - data.startTime;
  console.log(`\n=== Test Summary ===`);
  console.log(`Total duration: ${totalDuration}ms`);
  console.log("Auth test completed");
}
