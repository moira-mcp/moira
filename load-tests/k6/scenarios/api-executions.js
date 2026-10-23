/**
 * k6 execution-list workload for the current HTTP management API.
 * Samples unfiltered, running and completed reads. The accepted waiting alias
 * maps to running; it is not a separate input-wait-only projection.
 *
 * Run through scripts/run-load-testing.sh with an explicitly selected test target.
 * Authenticated scenarios require the backend load-test admission prerequisites
 * documented in load-tests/README.md. This scenario never starts or steps a run.
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

const errors = new Rate("errors");
const executionListDuration = new Trend("execution_list_duration", true);
const requestsTotal = new Counter("requests_total");
const profileName = __ENV.LOAD_PROFILE || "light";
const profile = loadProfiles[profileName] || loadProfiles.light;

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
    http_req_duration: ["p(50)<100", "p(95)<250", "p(99)<500"],
    http_req_failed: ["rate<0.01"],
    errors: ["rate<0.01"],
    execution_list_duration: ["p(95)<250"],
  },
  tags: { scenario: "api_executions" },
};

var sharedData = {};
const listQueries = [
  { name: "all", query: "limit=10" },
  { name: "waiting_alias", query: "status=waiting&limit=10" },
  { name: "running", query: "status=running&limit=10" },
  { name: "completed", query: "status=completed&limit=10" },
];

export function setup() {
  var apiUrl = getApiUrl();
  console.log("=== k6 API Execution Lists ===");
  console.log("Target: " + getBaseUrl());
  console.log("Profile: " + profileName + " - " + profile.description);
  console.log("Load test secret configured: " + isLoadTestSecretConfigured());
  var healthResponse = http.get(apiUrl + "/health", { timeout: "10s" });
  if (healthResponse.status !== 200) {
    throw new Error("Target not reachable: " + healthResponse.status);
  }
  return { startTime: Date.now(), apiUrl: apiUrl };
}

export default function (data) {
  if (!sharedData["session_" + __VU]) {
    var created = registerTestUser();
    if (!created) {
      errors.add(1);
      console.error("VU " + __VU + ": Failed to create session");
      sleep(1);
      return;
    }
    sharedData["session_" + __VU] = created;
  }
  var cookies = simpleCookies(sharedData["session_" + __VU].cookies);

  listQueries.forEach(function (selection) {
    group("list_executions_" + selection.name, function () {
      var response = http.get(data.apiUrl + "/executions?" + selection.query, {
        headers: httpDefaults.headers,
        cookies: cookies,
        tags: { name: "execution_list_" + selection.name },
      });
      requestsTotal.add(1);
      executionListDuration.add(response.timings.duration);
      var success = check(response, {
        "list status is 200": function (r) {
          return r.status === 200;
        },
        "list has executions array": function (r) {
          try {
            var body = JSON.parse(r.body);
            return body.success === true && body.data && Array.isArray(body.data.executions);
          } catch (_e) {
            return false;
          }
        },
        "list response time < 500ms": function (r) {
          return r.timings.duration < 500;
        },
      });
      errors.add(!success);
    });
    sleep(0.2);
  });
  sleep(0.3);
}

export function teardown(data) {
  console.log("\n=== API Execution Lists Summary ===");
  console.log("Total duration: " + (Date.now() - data.startTime) + "ms");
}
