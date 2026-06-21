/**
 * MCP Protection Integration Tests
 * Verifies MCP authentication layer functionality
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { describe, test, expect } from "@jest/globals";
import { getTestBaseUrl } from "../../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

describe("MCP Protection", () => {
  test("MCP endpoint returns 401 without token", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
      }),
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get("WWW-Authenticate");
    expect(wwwAuth).toContain("Bearer resource_metadata");

    const json = (await res.json()) as any;
    expect(json.error).toBe("invalid_token");
  });

  test("MCP initialize requires auth", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
      }),
    });

    expect(res.status).toBe(401);
  });
});
