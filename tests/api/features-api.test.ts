/**
 * Features API Tests
 *
 * Verifies the public GET /api/features contract the frontend depends on:
 * no auth required, the {success, data, timestamp} envelope, a valid
 * deploymentMode, and a boolean for every gated feature flag.
 *
 * Runs against the Docker container (DEPLOYMENT_MODE=saas in the test env), so
 * this asserts the response SHAPE, not mode-specific values (mode-specific UI
 * behavior is covered by tests/e2e/feature-mode-ui.spec.ts and the resolver
 * logic by tests/unit/shared/feature-resolver.test.ts).
 */

import { describe, test, expect } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

const EXPECTED_FEATURES = [
  "openRegistration",
  "emailVerificationGate",
  "verificationEmailOnSignup",
  "legalConsents",
  "betaNotices",
  "multiUserAdmin",
  "socialLogin",
] as const;

interface FeaturesResponse {
  success: boolean;
  data: {
    deploymentMode: "self-host" | "saas";
    features: Record<string, boolean>;
    mcpUrl: string;
  };
  timestamp: string;
}

describe("GET /api/features", () => {
  test("is public (no auth) and returns 200 with the standard envelope", async () => {
    const res = await fetch(`${BASE_URL}/api/features`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as FeaturesResponse;
    expect(body.success).toBe(true);
    expect(typeof body.timestamp).toBe("string");
    expect(body.data).toBeDefined();
  });

  test("reports a valid deployment mode", async () => {
    const res = await fetch(`${BASE_URL}/api/features`);
    const body = (await res.json()) as FeaturesResponse;
    expect(["self-host", "saas"]).toContain(body.data.deploymentMode);
  });

  test("returns a boolean for every gated feature flag", async () => {
    const res = await fetch(`${BASE_URL}/api/features`);
    const body = (await res.json()) as FeaturesResponse;

    const keys = Object.keys(body.data.features).sort();
    expect(keys).toEqual([...EXPECTED_FEATURES].sort());

    for (const feature of EXPECTED_FEATURES) {
      expect(typeof body.data.features[feature]).toBe("boolean");
    }
  });

  test("returns a runtime-resolved MCP URL: absolute, ending in /mcp, on the request host", async () => {
    const res = await fetch(`${BASE_URL}/api/features`);
    const body = (await res.json()) as FeaturesResponse;

    expect(typeof body.data.mcpUrl).toBe("string");
    expect(body.data.mcpUrl.length).toBeGreaterThan(0);

    // Must be an absolute http(s) URL ending in /mcp.
    const parsed = new URL(body.data.mcpUrl);
    expect(["http:", "https:"]).toContain(parsed.protocol);
    expect(parsed.pathname).toBe("/mcp");

    // The server derives the URL from its own configured host (MOIRA_HOST), so
    // it must point at the same host the test reached the API on — proving the
    // value is resolved from server config, not a build-time-baked default.
    const apiHost = new URL(BASE_URL).hostname;
    expect(parsed.hostname).toBe(apiHost);
  });
});
