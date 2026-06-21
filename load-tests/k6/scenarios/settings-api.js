/**
 * k6 Settings API Scenario
 *
 * Tests settings API endpoints for user settings management.
 * Uses authenticated requests with load test users.
 *
 * Endpoints tested:
 *   GET /api/settings - Get all user settings
 *   GET /api/settings/:category - Get settings by category
 *   PUT /api/settings - Update settings
 *
 * Usage:
 *   k6 run load-tests/k6/scenarios/settings-api.js
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
  registerTestUser,
  authGet,
  authPut,
  isLoadTestSecretConfigured,
} from "../lib/index.js";

// Custom metrics
const errors = new Rate("errors");
const settingsGetDuration = new Trend("settings_get_duration", true);
const settingsUpdateDuration = new Trend("settings_update_duration", true);
const requestsTotal = new Counter("requests_total");

// Get load profile from environment or use light
const profileName = __ENV.LOAD_PROFILE || "light";
const profile = loadProfiles[profileName] || loadProfiles.light;

// Test configuration
export const options = {
  scenarios: {
    settings_api: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: profile.stages,
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(50)<100", "p(95)<250", "p(99)<500"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.01"],
    settings_get_duration: ["p(95)<200"],
    settings_update_duration: ["p(95)<300"],
  },
  tags: {
    scenario: "settings_api",
  },
};

// Shared data between VUs
var sharedData = {};

/**
 * Setup function - runs once before test
 */
export function setup() {
  var apiUrl = getApiUrl();
  console.log("=== k6 Settings API Scenario ===");
  console.log("Target: " + getBaseUrl());
  console.log("Profile: " + profileName + " - " + profile.description);
  console.log("Load test secret configured: " + isLoadTestSecretConfigured());

  // Check if target is reachable
  var healthResponse = http.get(apiUrl + "/health", { timeout: "10s" });
  if (healthResponse.status !== 200) {
    throw new Error("Target not reachable: " + healthResponse.status);
  }
  console.log("Target is reachable");

  return {
    startTime: Date.now(),
    apiUrl: apiUrl,
  };
}

/**
 * Main test function - executed by each VU
 */
export default function (data) {
  var apiUrl = data.apiUrl;

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

  // Group 1: Get all settings
  group("get_all_settings", function () {
    var response = authGet(apiUrl + "/settings", cookies, {
      tags: { name: "settings_get_all" },
    });

    requestsTotal.add(1);
    settingsGetDuration.add(response.timings.duration);

    var success = check(response, {
      "get all settings status is 200": function (r) {
        return r.status === 200;
      },
      "get all settings has data": function (r) {
        try {
          var body = JSON.parse(r.body);
          return body.success === true && body.data !== undefined;
        } catch (_e) {
          return false;
        }
      },
      "get all settings response time < 500ms": function (r) {
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

  // Group 2: Get settings by category (telegram)
  group("get_settings_by_category", function () {
    var response = authGet(apiUrl + "/settings/telegram", cookies, {
      tags: { name: "settings_get_category" },
    });

    requestsTotal.add(1);
    settingsGetDuration.add(response.timings.duration);

    var success = check(response, {
      "get category settings status is 200": function (r) {
        return r.status === 200;
      },
      "get category settings has data": function (r) {
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

  // Group 3: Update a setting (toggle telegram notification preference)
  group("update_setting", function () {
    // Toggle telegram notifications setting - this is a valid boolean setting
    var payload = {
      "telegram.enabled": Math.random() > 0.5,
    };

    var response = authPut(apiUrl + "/settings", payload, cookies, {
      tags: { name: "settings_update" },
    });

    requestsTotal.add(1);
    settingsUpdateDuration.add(response.timings.duration);

    var success = check(response, {
      "update settings status is 200": function (r) {
        return r.status === 200;
      },
      "update settings returns success": function (r) {
        try {
          var body = JSON.parse(r.body);
          return body.success === true;
        } catch (_e) {
          return false;
        }
      },
      "update settings response time < 500ms": function (r) {
        return r.timings.duration < 500;
      },
    });

    if (!success) {
      errors.add(1);
    } else {
      errors.add(0);
    }
  });

  sleep(0.3);
}

/**
 * Teardown function - runs once after test
 */
export function teardown(data) {
  var totalDuration = Date.now() - data.startTime;
  console.log("\n=== Settings API Summary ===");
  console.log("Total duration: " + totalDuration + "ms");
}
