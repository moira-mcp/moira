/**
 * k6 API Executions Scenario
 *
 * Tests workflow execution endpoints:
 * - List executions
 * - Start workflow execution
 * - Execute workflow step
 *
 * Usage:
 *   docker compose -f docker-compose.k6.yml run --rm \
 *     -e TARGET_BASE_URL=http://host.docker.internal:3032 \
 *     -e LOAD_TEST_SECRET=your-secret-here \
 *     k6 run /scripts/scenarios/api-executions.js
 *
 * Environment variables:
 *   TARGET_BASE_URL - Base URL of target system
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
  isLoadTestSecretConfigured,
  simpleCookies,
} from "../lib/index.js";

// Custom metrics
const errors = new Rate("errors");
const executionListDuration = new Trend("execution_list_duration", true);
const executionStartDuration = new Trend("execution_start_duration", true);
const executionStepDuration = new Trend("execution_step_duration", true);
const requestsTotal = new Counter("requests_total");

// Get load profile from environment or use light
const profileName = __ENV.LOAD_PROFILE || "light";
const profile = loadProfiles[profileName] || loadProfiles.light;

// Test configuration
export const options = {
  scenarios: {
    api_executions: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: profile.stages,
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // Executions API - standard tier
    http_req_duration: ["p(50)<100", "p(95)<250", "p(99)<500"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.01"],
    execution_list_duration: ["p(95)<250"],
    execution_start_duration: ["p(95)<400"],
    execution_step_duration: ["p(95)<300"],
  },
  tags: {
    scenario: "api_executions",
  },
};

// Shared data between VUs
var sharedData = {};

/**
 * Setup function - runs once before test
 * Creates test user and finds a workflow for execution testing
 */
export function setup() {
  var apiUrl = getApiUrl();
  console.log("=== k6 API Executions Scenario ===");
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

  // Get list of public workflows that can be executed
  var cookies = simpleCookies(session.cookies);
  var workflowsResponse = http.get(apiUrl + "/workflows?visibility=public&limit=20", {
    headers: httpDefaults.headers,
    cookies: cookies,
  });

  var testWorkflowId = null;
  if (workflowsResponse.status === 200) {
    try {
      var body = JSON.parse(workflowsResponse.body);
      if (body.success && body.data && body.data.workflows && body.data.workflows.length > 0) {
        // Use the first public workflow for testing
        testWorkflowId = body.data.workflows[0].id;
      }
    } catch (_e) {
      console.warn("Failed to parse workflows response");
    }
  }

  if (testWorkflowId) {
    console.log("Using workflow for execution tests: " + testWorkflowId);
  } else {
    console.warn("No public workflows found - execution start tests will be limited");
  }

  return {
    startTime: Date.now(),
    apiUrl: apiUrl,
    testWorkflowId: testWorkflowId,
  };
}

/**
 * Main test function - executed by each VU
 */
export default function (data) {
  var apiUrl = data.apiUrl;
  var testWorkflowId = data.testWorkflowId;

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
  var cookies = simpleCookies(session.cookies);

  // Group 1: List all executions
  group("list_executions", function () {
    var response = http.get(apiUrl + "/executions?limit=10", {
      headers: httpDefaults.headers,
      cookies: cookies,
      tags: { name: "execution_list" },
    });

    requestsTotal.add(1);
    executionListDuration.add(response.timings.duration);

    var success = check(response, {
      "list status is 200": function (r) {
        return r.status === 200;
      },
      "list has executions data": function (r) {
        try {
          var body = JSON.parse(r.body);
          return body.success === true && body.data;
        } catch (_e) {
          return false;
        }
      },
      "list response time < 500ms": function (r) {
        return r.timings.duration < 500;
      },
    });

    if (!success) {
      errors.add(1);
    } else {
      errors.add(0);
    }
  });

  sleep(0.2);

  // Group 2: List waiting executions
  group("list_waiting_executions", function () {
    var response = http.get(apiUrl + "/executions?status=waiting&limit=10", {
      headers: httpDefaults.headers,
      cookies: cookies,
      tags: { name: "execution_list_waiting" },
    });

    requestsTotal.add(1);
    executionListDuration.add(response.timings.duration);

    var success = check(response, {
      "waiting list status is 200": function (r) {
        return r.status === 200;
      },
      "waiting list has data": function (r) {
        try {
          var body = JSON.parse(r.body);
          return body.success === true;
        } catch (_e) {
          return false;
        }
      },
    });

    if (!success) {
      errors.add(1);
    } else {
      errors.add(0);
    }
  });

  sleep(0.2);

  // Group 3: Start workflow execution (if we have a test workflow)
  // Only run occasionally to avoid creating too many executions
  if (testWorkflowId && __ITER % 5 === 0) {
    group("start_execution", function () {
      var payload = JSON.stringify({
        workflowId: testWorkflowId,
        note: "k6 load test execution - VU" + __VU + " iter" + __ITER,
        parentExecutionId: "none",
      });

      var response = http.post(apiUrl + "/executions/start", payload, {
        headers: httpDefaults.headers,
        cookies: cookies,
        tags: { name: "execution_start" },
      });

      requestsTotal.add(1);
      executionStartDuration.add(response.timings.duration);

      var processId = null;
      var success = check(response, {
        "start status is 200": function (r) {
          return r.status === 200;
        },
        "start has process ID": function (r) {
          try {
            var body = JSON.parse(r.body);
            if (body.success && body.data && body.data.processId) {
              processId = body.data.processId;
              return true;
            }
            return false;
          } catch (_e) {
            return false;
          }
        },
      });

      if (!success) {
        errors.add(1);
      } else {
        errors.add(0);

        // If we got a process ID, execute a step
        if (processId) {
          sleep(0.1);

          var stepPayload = JSON.stringify({
            processId: processId,
            input: { test: "k6 load test step" },
          });

          var stepResponse = http.post(apiUrl + "/executions/step", stepPayload, {
            headers: httpDefaults.headers,
            cookies: cookies,
            tags: { name: "execution_step" },
          });

          requestsTotal.add(1);
          executionStepDuration.add(stepResponse.timings.duration);

          var stepSuccess = check(stepResponse, {
            "step status is 200": function (r) {
              return r.status === 200;
            },
            "step has response": function (r) {
              try {
                var body = JSON.parse(r.body);
                return body.success === true || body.processId !== undefined;
              } catch (_e) {
                return false;
              }
            },
          });

          if (!stepSuccess) {
            errors.add(1);
          } else {
            errors.add(0);
          }
        }
      }
    });
  }

  sleep(0.3);
}

/**
 * Teardown function - runs once after test
 */
export function teardown(data) {
  var totalDuration = Date.now() - data.startTime;
  console.log("\n=== API Executions Summary ===");
  console.log("Total duration: " + totalDuration + "ms");
  console.log("Test workflow ID: " + (data.testWorkflowId || "none"));
}
