import { describe, test, expect } from "@jest/globals";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

describe("MSP spec", () => {
  test("/mcp must return 405 for GET if SSE are not supported", async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: "GET",
      headers: {
        Accept: "application/json, text/event-stream",
      },
    });

    expect(res.status).toBe(405);
  });
});
