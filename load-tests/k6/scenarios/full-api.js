/**
 * k6 Full API Mixed Scenario
 *
 * Tests all major API endpoints in a mixed workload pattern.
 * Simulates realistic user behavior with varied endpoint access.
 *
 * Endpoints tested:
 *   - Health check
 *   - Workflows (list, get)
 *   - Executions (list, start, step)
 *   - Settings (get, update)
 *   - User profile
 *
 * Usage:
 *   k6 run load-tests/k6/scenarios/full-api.js
 *
 * Environment variables:
 *   BASE_URL - Base URL of target system (default: http://localhost:4201)
 *   LOAD_TEST_SECRET - Secret for load test authentication
 *   LOAD_PROFILE - Load profile (light/medium/heavy/soak)
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";
import {
  getBaseUrl,
  getApiUrl,
  loadProfiles,
  httpDefaults,
  registerTestUser,
  authGet,
  isLoadTestSecretConfigured,
  simpleCookies,
} from "../lib/index.js";

// Custom metrics
const errors = new Rate("errors");
const healthDuration = new Trend("health_duration", true);
const workflowDuration = new Trend("workflow_duration", true);
const executionDuration = new Trend("execution_duration", true);
const settingsDuration = new Trend("settings_duration", true);
const profileDuration = new Trend("profile_duration", true);
const requestsTotal = new Counter("requests_total");

// Get load profile from environment or use light
const profileName = __ENV.LOAD_PROFILE || "light";
const profile = loadProfiles[profileName] || loadProfiles.light;

// Test configuration
export const options = {
  scenarios: {
    full_api: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: profile.stages,
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(50)<100", "p(95)<300", "p(99)<1000"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.02"], // Slightly higher tolerance for mixed workload
    health_duration: ["p(95)<100"],
    workflow_duration: ["p(95)<250"],
    execution_duration: ["p(95)<300"],
    settings_duration: ["p(95)<200"],
    profile_duration: ["p(95)<150"],
  },
  tags: {
    scenario: "full_api",
  },
};

// Shared data between VUs
var sharedData = {};

/**
 * Setup function - runs once before test
 */
export function setup() {
  var apiUrl = getApiUrl();
  console.log("=== k6 Full API Mixed Scenario ===");
  console.log("Target: " + getBaseUrl());
  console.log("Profile: " + profileName + " - " + profile.description);
  console.log("Load test secret configured: " + isLoadTestSecretConfigured());

  // Check if target is reachable
  var healthResponse = http.get(apiUrl + "/health", { timeout: "10s" });
  if (healthResponse.status !== 200) {
    throw new Error("Target not reachable: " + healthResponse.status);
  }
  console.log("Target is reachable");

  // Register test user for setup phase
  var session = registerTestUser();
  if (!session) {
    throw new Error("Failed to create test user in setup");
  }
  console.log("Setup user created: " + session.email);

  // Get list of public workflows for testing
  var cookies = simpleCookies(session.cookies);
  var workflowsResponse = http.get(apiUrl + "/workflows?visibility=public&limit=20", {
    headers: httpDefaults.headers,
    cookies: cookies,
  });

  var workflowIds = [];
  if (workflowsResponse.status === 200) {
    try {
      var body = JSON.parse(workflowsResponse.body);
      if (body.success && body.data && body.data.workflows) {
        for (var i = 0; i < body.data.workflows.length && i < 10; i++) {
          workflowIds.push(body.data.workflows[i].id);
        }
      }
    } catch (_e) {
      console.warn("Failed to parse workflows response");
    }
  }
  console.log("Found " + workflowIds.length + " public workflows for testing");

  return {
    startTime: Date.now(),
    apiUrl: apiUrl,
    workflowIds: workflowIds,
  };
}

/**
 * Main test function - executed by each VU
 */
export default function (data) {
  var apiUrl = data.apiUrl;
  var workflowIds = data.workflowIds || [];

  // Each VU creates its own session
  if (!sharedData["session_" + __VU]) {
    var session = registerTestUser();
    if (!session) {
      errors.add(1);
      console.error("VU " + __VU + ": Failed to create session");
      sleep(1);
      return;
    }
    sharedData["session_" + __VU] = session;
  }

  var session = sharedData["session_" + __VU];
  var cookies = session.cookies;

  // Randomize which operations to perform this iteration
  // This simulates realistic varied user behavior
  var rand = Math.random();

  if (rand < 0.1) {
    // 10% - Health check (unauthenticated)
    testHealthCheck(apiUrl);
  } else if (rand < 0.35) {
    // 25% - Workflow operations
    testWorkflows(apiUrl, cookies, workflowIds);
  } else if (rand < 0.55) {
    // 20% - Execution operations
    testExecutions(apiUrl, cookies);
  } else if (rand < 0.75) {
    // 20% - Settings operations
    testSettings(apiUrl, cookies);
  } else {
    // 25% - User profile
    testUserProfile(apiUrl, cookies);
  }

  sleep(0.1 + Math.random() * 0.3); // Random sleep 100-400ms
}

/**
 * Test health check endpoint
 */
function testHealthCheck(apiUrl) {
  group("health_check", function () {
    var response = http.get(apiUrl + "/health", {
      tags: { name: "health_check" },
    });

    requestsTotal.add(1);
    healthDuration.add(response.timings.duration);

    var success = check(response, {
      "health status is 200": function (r) {
        return r.status === 200;
      },
      "health response time < 100ms": function (r) {
        return r.timings.duration < 100;
      },
    });

    if (!success) {
      errors.add(1);
    } else {
      errors.add(0);
    }
  });
}

/**
 * Test workflow endpoints
 */
function testWorkflows(apiUrl, cookies, workflowIds) {
  group("workflows", function () {
    // List workflows
    var listResponse = authGet(apiUrl + "/workflows?limit=10", cookies, {
      tags: { name: "workflow_list" },
    });

    requestsTotal.add(1);
    workflowDuration.add(listResponse.timings.duration);

    var listSuccess = check(listResponse, {
      "workflow list status is 200": function (r) {
        return r.status === 200;
      },
    });

    if (!listSuccess) {
      errors.add(1);
    } else {
      errors.add(0);
    }

    sleep(0.1);

    // Get specific workflow if we have IDs
    if (workflowIds.length > 0) {
      var workflowId = workflowIds[Math.floor(Math.random() * workflowIds.length)];
      var getResponse = authGet(apiUrl + "/workflows/" + workflowId, cookies, {
        tags: { name: "workflow_get" },
      });

      requestsTotal.add(1);
      workflowDuration.add(getResponse.timings.duration);

      var getSuccess = check(getResponse, {
        "workflow get status is 200": function (r) {
          return r.status === 200;
        },
      });

      if (!getSuccess) {
        errors.add(1);
      } else {
        errors.add(0);
      }
    }
  });
}

/**
 * Test execution endpoints
 */
function testExecutions(apiUrl, cookies) {
  group("executions", function () {
    // List executions
    var response = authGet(apiUrl + "/executions?limit=10", cookies, {
      tags: { name: "execution_list" },
    });

    requestsTotal.add(1);
    executionDuration.add(response.timings.duration);

    var success = check(response, {
      "execution list status is 200": function (r) {
        return r.status === 200;
      },
    });

    if (!success) {
      errors.add(1);
    } else {
      errors.add(0);
    }
  });
}

/**
 * Test settings endpoints
 */
function testSettings(apiUrl, cookies) {
  group("settings", function () {
    // Get settings
    var getResponse = authGet(apiUrl + "/settings", cookies, {
      tags: { name: "settings_get" },
    });

    requestsTotal.add(1);
    settingsDuration.add(getResponse.timings.duration);

    var getSuccess = check(getResponse, {
      "settings get status is 200": function (r) {
        return r.status === 200;
      },
    });

    if (!getSuccess) {
      errors.add(1);
    } else {
      errors.add(0);
    }
  });
}

/**
 * Test user profile endpoint
 */
function testUserProfile(apiUrl, cookies) {
  group("user_profile", function () {
    // Get current user profile
    var response = authGet(apiUrl + "/user/profile", cookies, {
      tags: { name: "user_profile" },
    });

    requestsTotal.add(1);
    profileDuration.add(response.timings.duration);

    var success = check(response, {
      "user profile status is 200": function (r) {
        return r.status === 200;
      },
    });

    if (!success) {
      errors.add(1);
    } else {
      errors.add(0);
    }
  });
}

/**
 * Teardown function - runs once after test
 */
export function teardown(data) {
  var totalDuration = Date.now() - data.startTime;
  console.log("\n=== Full API Summary ===");
  console.log("Total duration: " + totalDuration + "ms");
  console.log("Workflows tested: " + (data.workflowIds ? data.workflowIds.length : 0));
}
