/**
 * k6 MCP Tools Scenario
 *
 * Simulates MCP tool usage patterns by testing the underlying API endpoints
 * that MCP tools use internally. This validates the backend performance
 * for MCP client workloads.
 *
 * MCP tools tested (via REST API):
 *   - list: List workflows (GET /api/workflows)
 *   - start: Start workflow execution (POST /api/executions/start)
 *   - step: Execute workflow step (POST /api/executions/:id/step)
 *   - session: Get executions (GET /api/executions)
 *
 * Usage:
 *   k6 run load-tests/k6/scenarios/mcp-tools.js
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
  authPost,
  isLoadTestSecretConfigured,
  simpleCookies,
} from "../lib/index.js";

// Custom metrics
const errors = new Rate("errors");
const listDuration = new Trend("mcp_list_duration", true);
const startDuration = new Trend("mcp_start_duration", true);
const stepDuration = new Trend("mcp_step_duration", true);
const sessionDuration = new Trend("mcp_session_duration", true);
const requestsTotal = new Counter("requests_total");

// Get load profile from environment or use light
const profileName = __ENV.LOAD_PROFILE || "light";
const profile = loadProfiles[profileName] || loadProfiles.light;

// Test configuration
export const options = {
  scenarios: {
    mcp_tools: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: profile.stages,
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(50)<100", "p(95)<300", "p(99)<1000"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.02"],
    mcp_list_duration: ["p(95)<200"],
    mcp_start_duration: ["p(95)<500"],
    mcp_step_duration: ["p(95)<500"],
    mcp_session_duration: ["p(95)<200"],
  },
  tags: {
    scenario: "mcp_tools",
  },
};

// Shared data between VUs
var sharedData = {};

/**
 * Setup function - runs once before test
 */
export function setup() {
  var apiUrl = getApiUrl();
  console.log("=== k6 MCP Tools Scenario ===");
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
        for (var i = 0; i < body.data.workflows.length && i < 5; i++) {
          workflowIds.push(body.data.workflows[i].id);
        }
      }
    } catch (_e) {
      console.warn("Failed to parse workflows response");
    }
  }
  console.log("Found " + workflowIds.length + " public workflows for MCP testing");

  return {
    startTime: Date.now(),
    apiUrl: apiUrl,
    workflowIds: workflowIds,
  };
}

/**
 * Main test function - executed by each VU
 * Simulates MCP tool usage patterns
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

  // MCP tool usage patterns - weighted by typical usage
  var rand = Math.random();

  if (rand < 0.35) {
    // 35% - list workflows (most common MCP operation)
    mcpList(apiUrl, cookies);
  } else if (rand < 0.55) {
    // 20% - session/executions (checking active executions)
    mcpSession(apiUrl, cookies);
  } else if (rand < 0.8) {
    // 25% - start workflow (initiating new execution)
    mcpStart(apiUrl, cookies, workflowIds);
  } else {
    // 20% - step execution (advancing workflow)
    mcpStep(apiUrl, cookies);
  }

  sleep(0.2 + Math.random() * 0.2);
}

/**
 * MCP list tool - list available workflows
 */
function mcpList(apiUrl, cookies) {
  group("mcp_list", function () {
    // MCP list can filter by search and visibility
    var queries = [
      "?limit=20",
      "?visibility=public&limit=20",
      "?visibility=private&limit=20",
      "?search=test&limit=10",
    ];
    var query = queries[Math.floor(Math.random() * queries.length)];

    var response = authGet(apiUrl + "/workflows" + query, cookies, {
      tags: { name: "mcp_list" },
    });

    requestsTotal.add(1);
    listDuration.add(response.timings.duration);

    var success = check(response, {
      "mcp list status is 200": function (r) {
        return r.status === 200;
      },
      "mcp list has workflows": function (r) {
        try {
          var body = JSON.parse(r.body);
          return body.success === true && body.data && Array.isArray(body.data.workflows);
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
}

/**
 * MCP session tool - list executions
 */
function mcpSession(apiUrl, cookies) {
  group("mcp_session", function () {
    // Different session queries
    var queries = [
      "?limit=10",
      "?status=running&limit=10",
      "?status=waiting&limit=10",
      "?status=completed&limit=10",
    ];
    var query = queries[Math.floor(Math.random() * queries.length)];

    var response = authGet(apiUrl + "/executions" + query, cookies, {
      tags: { name: "mcp_session" },
    });

    requestsTotal.add(1);
    sessionDuration.add(response.timings.duration);

    var success = check(response, {
      "mcp session status is 200": function (r) {
        return r.status === 200;
      },
      "mcp session has executions": function (r) {
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
}

/**
 * MCP start tool - start workflow execution
 */
function mcpStart(apiUrl, cookies, workflowIds) {
  group("mcp_start", function () {
    if (workflowIds.length === 0) {
      // Fallback to list if no workflows available
      mcpList(apiUrl, cookies);
      return;
    }

    var workflowId = workflowIds[Math.floor(Math.random() * workflowIds.length)];
    var payload = {
      workflowId: workflowId,
      note: "k6 load test execution",
    };

    var response = authPost(apiUrl + "/executions/start", payload, cookies, {
      tags: { name: "mcp_start" },
    });

    requestsTotal.add(1);
    startDuration.add(response.timings.duration);

    // Start may return 200 (success) or 4xx (validation error)
    var success = check(response, {
      "mcp start status is valid": function (r) {
        return r.status === 200 || r.status === 201 || r.status === 400 || r.status === 404;
      },
    });

    if (!success) {
      errors.add(1);
    } else {
      errors.add(0);
    }

    // Store execution ID for step tests if successful
    if (response.status === 200 || response.status === 201) {
      try {
        var body = JSON.parse(response.body);
        if (body.processId) {
          sharedData["execution_" + __VU] = body.processId;
        }
      } catch (_e) {
        // Ignore parse errors
      }
    }
  });
}

/**
 * MCP step tool - execute next step in workflow
 */
function mcpStep(apiUrl, cookies) {
  group("mcp_step", function () {
    // Try to use existing execution or get one from session
    var executionId = sharedData["execution_" + __VU];

    if (!executionId) {
      // No execution - just do session query instead
      mcpSession(apiUrl, cookies);
      return;
    }

    var payload = {
      input: "test input from k6",
    };

    var response = authPost(apiUrl + "/executions/" + executionId + "/step", payload, cookies, {
      tags: { name: "mcp_step" },
    });

    requestsTotal.add(1);
    stepDuration.add(response.timings.duration);

    // Step may return various status codes depending on workflow state
    var success = check(response, {
      "mcp step status is valid": function (r) {
        return r.status === 200 || r.status === 400 || r.status === 404 || r.status === 409;
      },
    });

    if (!success) {
      errors.add(1);
    } else {
      errors.add(0);
    }

    // Clear execution if completed or failed
    if (response.status === 404 || response.status === 409) {
      delete sharedData["execution_" + __VU];
    }
  });
}

/**
 * Teardown function - runs once after test
 */
export function teardown(data) {
  var totalDuration = Date.now() - data.startTime;
  console.log("\n=== MCP Tools Summary ===");
  console.log("Total duration: " + totalDuration + "ms");
  console.log("Workflows available: " + (data.workflowIds ? data.workflowIds.length : 0));
  console.log("");
  console.log("MCP tool metrics:");
  console.log("  - mcp_list_duration: Workflow listing");
  console.log("  - mcp_start_duration: Execution start");
  console.log("  - mcp_step_duration: Step execution");
  console.log("  - mcp_session_duration: Session/execution queries");
}
