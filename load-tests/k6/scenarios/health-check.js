/**
 * k6 Health Check Scenario
 *
 * Light load profile testing the /api/health endpoint.
 * This is the simplest scenario for validating infrastructure.
 *
 * Usage:
 *   docker compose -f docker-compose.k6.yml run --rm \
 *     -e TARGET_BASE_URL=http://host.docker.internal:3032 \
 *     k6 run /scripts/scenarios/health-check.js
 *
 * With InfluxDB output:
 *   docker compose -f docker-compose.k6.yml run --rm \
 *     -e TARGET_BASE_URL=http://host.docker.internal:3032 \
 *     -e K6_OUT=influxdb=http://influxdb:8086/k6 \
 *     k6 run /scripts/scenarios/health-check.js
 *
 * Environment variables:
 *   TARGET_BASE_URL - Base URL of target system
 *   LOAD_PROFILE - Load profile (light/medium/heavy/soak)
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import {
  getBaseUrl,
  getApiUrl,
  loadProfiles,
  httpDefaults,
  rateLimitBypass,
} from "../lib/index.js";

// Custom metrics
const errorRate = new Rate("errors");
const healthCheckDuration = new Trend("health_check_duration");

// Get load profile from environment or use light
const profileName = __ENV.LOAD_PROFILE || "light";
const profile = loadProfiles[profileName] || loadProfiles.light;

// Test configuration
export const options = {
  scenarios: {
    health_check: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: profile.stages,
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // Health check should be very fast - critical tier
    http_req_duration: ["p(50)<50", "p(95)<100", "p(99)<200"],
    http_req_failed: ["rate<0.001"], // 0.1% error rate max
    errors: ["rate<0.001"],
    health_check_duration: ["p(95)<100"],
  },
  tags: {
    scenario: "health_check",
  },
};

export default function (data) {
  var apiUrl = data.apiUrl;

  // Health check endpoint
  var healthRes = http.get(apiUrl + "/health", {
    headers: httpDefaults.headers,
    tags: { name: "health_check" },
  });

  // Verify response
  var healthOk = check(healthRes, {
    "status is 200": function (r) {
      return r.status === 200;
    },
    "response time < 200ms": function (r) {
      return r.timings.duration < 200;
    },
    "has status ok": function (r) {
      try {
        var body = JSON.parse(r.body);
        return body.data && body.data.status === "ok";
      } catch (_e) {
        return false;
      }
    },
  });

  // Record custom metrics
  errorRate.add(!healthOk);
  healthCheckDuration.add(healthRes.timings.duration);

  // Small sleep between iterations
  sleep(0.1);
}

// Setup function - runs once before the test
export function setup() {
  var apiUrl = getApiUrl();
  console.log("=== k6 Health Check Scenario ===");
  console.log("Target: " + getBaseUrl());
  console.log("Profile: " + profileName + " - " + profile.description);
  console.log("API URL: " + apiUrl);

  // Verify target is reachable
  var res = http.get(apiUrl + "/health", { timeout: "10s" });
  if (res.status !== 200) {
    throw new Error("Target not reachable: " + apiUrl + " returned " + res.status);
  }

  console.log("Target is reachable - status: " + res.status);
  console.log("Rate limit bypass: " + (rateLimitBypass.enabled ? "enabled" : "disabled"));
  return { apiUrl: apiUrl };
}

// Teardown function - runs once after the test
export function teardown(_data) {
  console.log("Health check scenario completed");
}
