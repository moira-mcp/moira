/**
 * k6 API Workflows Scenario
 *
 * Tests workflow listing and workflow details endpoints.
 * Uses authenticated requests with load test users.
 *
 * Usage:
 *   docker compose -f docker-compose.k6.yml run --rm \
 *     -e TARGET_BASE_URL=http://host.docker.internal:3032 \
 *     -e LOAD_TEST_SECRET=your-secret-here \
 *     k6 run /scripts/scenarios/api-workflows.js
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
  authGet,
  isLoadTestSecretConfigured,
  simpleCookies,
} from "../lib/index.js";

// Custom metrics
const errors = new Rate("errors");
const workflowListDuration = new Trend("workflow_list_duration", true);
const workflowGetDuration = new Trend("workflow_get_duration", true);
const requestsTotal = new Counter("requests_total");

// Get load profile from environment or use light
const profileName = __ENV.LOAD_PROFILE || "light";
const profile = loadProfiles[profileName] || loadProfiles.light;

// Test configuration
export const options = {
  scenarios: {
    api_workflows: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: profile.stages,
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // Workflows API - standard tier
    http_req_duration: ["p(50)<100", "p(95)<250", "p(99)<500"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.01"],
    workflow_list_duration: ["p(95)<200"],
    workflow_get_duration: ["p(95)<150"],
  },
  tags: {
    scenario: "api_workflows",
  },
};

// Shared data between VUs - populated in setup
var sharedData = {};

/**
 * Setup function - runs once before test
 * Creates test user and gets initial workflow list
 */
export function setup() {
  var apiUrl = getApiUrl();
  console.log("=== k6 API Workflows Scenario ===");
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

  // Group 1: List workflows
  group("list_workflows", function () {
    var response = authGet(apiUrl + "/workflows?limit=10", cookies, {
      tags: { name: "workflow_list" },
    });

    requestsTotal.add(1);
    workflowListDuration.add(response.timings.duration);

    var success = check(response, {
      "list status is 200": function (r) {
        return r.status === 200;
      },
      "list has workflows array": function (r) {
        try {
          var body = JSON.parse(r.body);
          return body.success === true && body.data && Array.isArray(body.data.workflows);
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

  // Group 2: List public workflows
  group("list_public_workflows", function () {
    var response = authGet(apiUrl + "/workflows?visibility=public&limit=10", cookies, {
      tags: { name: "workflow_list_public" },
    });

    requestsTotal.add(1);
    workflowListDuration.add(response.timings.duration);

    var success = check(response, {
      "public list status is 200": function (r) {
        return r.status === 200;
      },
      "public list has data": function (r) {
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

  // Group 3: Get specific workflow (if we have any workflow IDs)
  if (workflowIds.length > 0) {
    group("get_workflow", function () {
      // Pick random workflow ID
      var workflowId = workflowIds[Math.floor(Math.random() * workflowIds.length)];

      var response = authGet(apiUrl + "/workflows/" + workflowId, cookies, {
        tags: { name: "workflow_get" },
      });

      requestsTotal.add(1);
      workflowGetDuration.add(response.timings.duration);

      var success = check(response, {
        "get status is 200": function (r) {
          return r.status === 200;
        },
        "get has workflow data": function (r) {
          try {
            var body = JSON.parse(r.body);
            return body.success === true && body.data && body.data.id;
          } catch (_e) {
            return false;
          }
        },
        "get response time < 300ms": function (r) {
          return r.timings.duration < 300;
        },
      });

      if (!success) {
        errors.add(1);
      } else {
        errors.add(0);
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
  console.log("\n=== API Workflows Summary ===");
  console.log("Total duration: " + totalDuration + "ms");
  console.log("Workflows tested: " + (data.workflowIds ? data.workflowIds.length : 0));
}
