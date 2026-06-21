/**
 * k6 Soak Test Scenario
 *
 * Long-running test to detect memory leaks, resource exhaustion,
 * and stability issues over time.
 *
 * Load profile: 50 RPS sustained for 30 minutes
 *
 * Usage:
 *   k6 run load-tests/k6/scenarios/soak.js
 *
 * Environment variables:
 *   BASE_URL - Base URL of target system (default: http://localhost:4201)
 *   LOAD_TEST_SECRET - Secret for load test authentication
 *   SOAK_DURATION - Override soak duration (default: 30m)
 */

import http from "k6/http";
import { sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";
import {
  getBaseUrl,
  getApiUrl,
  httpDefaults,
  registerTestUser,
  authGet,
  isLoadTestSecretConfigured,
  simpleCookies,
} from "../lib/index.js";

// Custom metrics
const errors = new Rate("errors");
const requestDuration = new Trend("request_duration", true);
const requestsTotal = new Counter("requests_total");
const requestsSuccess = new Counter("requests_success");
const requestsFailed = new Counter("requests_failed");

// Time-based metrics to track degradation
const durationTrend = new Trend("duration_over_time", true);
const errorRateTrend = new Trend("error_rate_over_time", true);

// Soak test load profile - sustained moderate load
const soakDuration = __ENV.SOAK_DURATION || "30m";
const soakProfile = {
  stages: [
    { duration: "2m", target: 50 }, // Ramp up to target
    { duration: soakDuration, target: 50 }, // Sustained load
    { duration: "2m", target: 0 }, // Ramp down
  ],
  description: "Soak test (50 VUs sustained for " + soakDuration + ")",
};

// Test configuration
export const options = {
  scenarios: {
    soak_test: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: soakProfile.stages,
      gracefulRampDown: "60s",
    },
  },
  thresholds: {
    // Standard thresholds - soak test should maintain performance
    http_req_duration: ["p(50)<100", "p(95)<300", "p(99)<1000"],
    http_req_failed: ["rate<0.01"], // Expect high reliability
    errors: ["rate<0.02"],
    // Monitor for degradation over time
    duration_over_time: ["p(95)<500"], // Should not degrade significantly
  },
  tags: {
    scenario: "soak_test",
  },
};

// Shared data between VUs
var sharedData = {};

// Track metrics over time windows (reserved for future use)
var _timeWindowMetrics = {
  windowStart: 0,
  windowErrors: 0,
  windowRequests: 0,
  windowDurations: [],
};

/**
 * Setup function - runs once before test
 */
export function setup() {
  var apiUrl = getApiUrl();
  console.log("=== k6 Soak Test Scenario ===");
  console.log("Target: " + getBaseUrl());
  console.log("Profile: " + soakProfile.description);
  console.log("Load test secret configured: " + isLoadTestSecretConfigured());
  console.log("");
  console.log("Soak test monitors for:");
  console.log("  - Memory leaks (response time degradation)");
  console.log("  - Connection pool exhaustion");
  console.log("  - Database connection issues");
  console.log("  - Resource cleanup problems");

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
 * Steady workload with periodic metrics collection
 */
export default function (data) {
  var apiUrl = data.apiUrl;
  var workflowIds = data.workflowIds || [];

  // Each VU creates its own session
  if (!sharedData["session_" + __VU]) {
    var session = registerTestUser();
    if (!session) {
      errors.add(1);
      requestsFailed.add(1);
      sleep(1);
      return;
    }
    sharedData["session_" + __VU] = session;
  }

  var session = sharedData["session_" + __VU];
  var cookies = session.cookies;

  // Varied workload - realistic user simulation
  var rand = Math.random();

  var result;
  if (rand < 0.15) {
    result = doHealthCheck(apiUrl);
  } else if (rand < 0.4) {
    result = doWorkflowList(apiUrl, cookies);
  } else if (rand < 0.55) {
    result = doWorkflowGet(apiUrl, cookies, workflowIds);
  } else if (rand < 0.7) {
    result = doExecutionList(apiUrl, cookies);
  } else if (rand < 0.85) {
    result = doSettingsGet(apiUrl, cookies);
  } else {
    result = doUserProfile(apiUrl, cookies);
  }

  // Track metrics over time for degradation detection
  if (result) {
    durationTrend.add(result.duration);
    errorRateTrend.add(result.success ? 0 : 1);
  }

  // Moderate sleep - maintain ~50 RPS per VU across all operations
  sleep(0.2 + Math.random() * 0.3);
}

function doHealthCheck(apiUrl) {
  var response = http.get(apiUrl + "/health", {
    tags: { name: "soak_health" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  var success = response.status === 200;
  if (success) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }

  return { duration: response.timings.duration, success: success };
}

function doWorkflowList(apiUrl, cookies) {
  var response = authGet(apiUrl + "/workflows?limit=10", cookies, {
    tags: { name: "soak_workflow_list" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  var success = response.status === 200;
  if (success) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }

  return { duration: response.timings.duration, success: success };
}

function doWorkflowGet(apiUrl, cookies, workflowIds) {
  if (workflowIds.length === 0) {
    return doWorkflowList(apiUrl, cookies);
  }

  var workflowId = workflowIds[Math.floor(Math.random() * workflowIds.length)];
  var response = authGet(apiUrl + "/workflows/" + workflowId, cookies, {
    tags: { name: "soak_workflow_get" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  var success = response.status === 200;
  if (success) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }

  return { duration: response.timings.duration, success: success };
}

function doExecutionList(apiUrl, cookies) {
  var response = authGet(apiUrl + "/executions?limit=10", cookies, {
    tags: { name: "soak_execution_list" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  var success = response.status === 200;
  if (success) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }

  return { duration: response.timings.duration, success: success };
}

function doSettingsGet(apiUrl, cookies) {
  var response = authGet(apiUrl + "/settings", cookies, {
    tags: { name: "soak_settings" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  var success = response.status === 200;
  if (success) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }

  return { duration: response.timings.duration, success: success };
}

function doUserProfile(apiUrl, cookies) {
  var response = authGet(apiUrl + "/user/profile", cookies, {
    tags: { name: "soak_user_profile" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  var success = response.status === 200;
  if (success) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }

  return { duration: response.timings.duration, success: success };
}

/**
 * Teardown function - runs once after test
 */
export function teardown(data) {
  var totalDuration = Date.now() - data.startTime;
  var totalMinutes = (totalDuration / 1000 / 60).toFixed(1);

  console.log("\n=== Soak Test Summary ===");
  console.log("Total duration: " + totalMinutes + " minutes");
  console.log("Workflows tested: " + (data.workflowIds ? data.workflowIds.length : 0));
  console.log("");
  console.log("Review metrics for degradation:");
  console.log("  - duration_over_time: Should remain stable throughout test");
  console.log("  - error_rate_over_time: Should remain low (<1%)");
  console.log("  - request_duration p95/p99: Check for gradual increase");
  console.log("");
  console.log("Signs of issues:");
  console.log("  - Increasing latency over time = memory leak");
  console.log("  - Sudden error spikes = resource exhaustion");
  console.log("  - Connection timeouts = pool exhaustion");
}
