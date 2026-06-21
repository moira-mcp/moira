/**
 * k6 Stress Test Scenario
 *
 * High-load stress test to validate system behavior under extreme load.
 * Tests rate limiting, error handling, and system stability.
 *
 * Load profile: 200 RPS peak with aggressive ramp
 *
 * Usage:
 *   k6 run load-tests/k6/scenarios/stress.js
 *
 * Environment variables:
 *   BASE_URL - Base URL of target system (default: http://localhost:4201)
 *   LOAD_TEST_SECRET - Secret for load test authentication
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
const rateLimitHits = new Counter("rate_limit_hits");
const requestDuration = new Trend("request_duration", true);
const requestsTotal = new Counter("requests_total");
const requestsSuccess = new Counter("requests_success");
const requestsFailed = new Counter("requests_failed");

// Stress test load profile - aggressive ramp to 200 RPS
const stressProfile = {
  stages: [
    { duration: "2m", target: 50 }, // Ramp up to 50 VUs
    { duration: "3m", target: 100 }, // Continue to 100 VUs
    { duration: "5m", target: 200 }, // Push to 200 VUs (peak stress)
    { duration: "5m", target: 200 }, // Hold at peak
    { duration: "3m", target: 100 }, // Begin ramp down
    { duration: "2m", target: 0 }, // Complete ramp down
  ],
  description: "Stress test (200 VUs peak, aggressive ramp)",
};

// Test configuration
export const options = {
  scenarios: {
    stress_test: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: stressProfile.stages,
      gracefulRampDown: "60s",
    },
  },
  thresholds: {
    // Relaxed thresholds for stress test - expect some degradation
    http_req_duration: ["p(50)<500", "p(95)<2000", "p(99)<5000"],
    http_req_failed: ["rate<0.10"], // Allow up to 10% failure under extreme load
    errors: ["rate<0.15"], // Higher tolerance
    // Track but don't fail on rate limiting
    rate_limit_hits: ["count>0"], // Expect some rate limits to be hit
  },
  tags: {
    scenario: "stress_test",
  },
};

// Shared data between VUs
var sharedData = {};

/**
 * Setup function - runs once before test
 */
export function setup() {
  var apiUrl = getApiUrl();
  console.log("=== k6 Stress Test Scenario ===");
  console.log("Target: " + getBaseUrl());
  console.log("Profile: " + stressProfile.description);
  console.log("Load test secret configured: " + isLoadTestSecretConfigured());
  console.log("");
  console.log("WARNING: Stress test will push system to limits!");
  console.log("Expected behavior: rate limiting, degraded performance");

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
 * Mixed workload with emphasis on high throughput
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
      // Don't log every failure under stress - too noisy
      sleep(0.5);
      return;
    }
    sharedData["session_" + __VU] = session;
  }

  var session = sharedData["session_" + __VU];
  var cookies = session.cookies;

  // Rapid-fire mixed requests to stress the system
  var operations = [
    function () {
      return doHealthCheck(apiUrl);
    },
    function () {
      return doWorkflowList(apiUrl, cookies);
    },
    function () {
      return doWorkflowGet(apiUrl, cookies, workflowIds);
    },
    function () {
      return doExecutionList(apiUrl, cookies);
    },
    function () {
      return doSettingsGet(apiUrl, cookies);
    },
  ];

  // Pick random operation
  var opIndex = Math.floor(Math.random() * operations.length);
  operations[opIndex]();

  // Minimal sleep under stress - maximize RPS
  sleep(0.05 + Math.random() * 0.1);
}

function doHealthCheck(apiUrl) {
  var response = http.get(apiUrl + "/health", {
    tags: { name: "stress_health" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  if (response.status === 429) {
    rateLimitHits.add(1);
  }

  if (response.status === 200) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }
}

function doWorkflowList(apiUrl, cookies) {
  var response = authGet(apiUrl + "/workflows?limit=5", cookies, {
    tags: { name: "stress_workflow_list" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  if (response.status === 429) {
    rateLimitHits.add(1);
  }

  if (response.status === 200) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }
}

function doWorkflowGet(apiUrl, cookies, workflowIds) {
  if (workflowIds.length === 0) {
    return doWorkflowList(apiUrl, cookies);
  }

  var workflowId = workflowIds[Math.floor(Math.random() * workflowIds.length)];
  var response = authGet(apiUrl + "/workflows/" + workflowId, cookies, {
    tags: { name: "stress_workflow_get" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  if (response.status === 429) {
    rateLimitHits.add(1);
  }

  if (response.status === 200) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }
}

function doExecutionList(apiUrl, cookies) {
  var response = authGet(apiUrl + "/executions?limit=5", cookies, {
    tags: { name: "stress_execution_list" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  if (response.status === 429) {
    rateLimitHits.add(1);
  }

  if (response.status === 200) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }
}

function doSettingsGet(apiUrl, cookies) {
  var response = authGet(apiUrl + "/settings", cookies, {
    tags: { name: "stress_settings" },
  });

  requestsTotal.add(1);
  requestDuration.add(response.timings.duration);

  if (response.status === 429) {
    rateLimitHits.add(1);
  }

  if (response.status === 200) {
    requestsSuccess.add(1);
    errors.add(0);
  } else {
    requestsFailed.add(1);
    errors.add(1);
  }
}

/**
 * Teardown function - runs once after test
 */
export function teardown(data) {
  var totalDuration = Date.now() - data.startTime;
  console.log("\n=== Stress Test Summary ===");
  console.log("Total duration: " + (totalDuration / 1000 / 60).toFixed(1) + " minutes");
  console.log("Workflows tested: " + (data.workflowIds ? data.workflowIds.length : 0));
  console.log("");
  console.log("Check metrics for:");
  console.log("  - rate_limit_hits: Number of 429 responses");
  console.log("  - requests_success vs requests_failed: Success rate");
  console.log("  - request_duration p95/p99: Latency under stress");
}
