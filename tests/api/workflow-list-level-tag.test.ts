/**
 * GET /api/workflows?search=… — the catalogue search looks at what a flow is about, not at the
 * level it was authored at: a flow whose only mention of "complexity" is its level tag
 * (`complexity:<level>`, written by the Workflow Management Flow) is not found by searching for
 * that word, while a flow that is about it is.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import fetch from "node-fetch";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createTestUserViaApi, formatSessionCookie, signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestPass123!";

async function createFlow(cookie: string, name: string, tags: string[]): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      visibility: "private",
      workflow: {
        metadata: { name, version: "1.0.0", description: `${name} for the search check`, tags },
        nodes: [
          { type: "start", id: "start", connections: { default: "end" } },
          { type: "end", id: "end" },
        ],
      },
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { workflowId: string } }).data.workflowId;
}

describe("catalogue search and the level tag", () => {
  let cookie = "";
  const created: string[] = [];

  beforeAll(async () => {
    const email = `list-level-${Date.now()}@example.com`;
    await createTestUserViaApi(BASE_URL, email, PASSWORD, "List level");
    cookie = formatSessionCookie(BASE_URL, await signInUser(BASE_URL, email, PASSWORD));
    created.push(await createFlow(cookie, "Onboarding checklist", ["complexity:simple", "hr"]));
    created.push(await createFlow(cookie, "Complexity budget review", ["finance"]));
  });

  afterAll(async () => {
    for (const id of created) {
      await fetch(`${BASE_URL}/api/workflows/${id}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      });
    }
  });

  test("searching for the level word finds the flow about it, not the flow that only carries the level tag", async () => {
    const response = await fetch(
      `${BASE_URL}/api/workflows?access=mine&search=complexity&limit=50`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(response.status).toBe(200);
    const page = (
      (await response.json()) as { data: { workflows: { metadata: { name: string } }[] } }
    ).data;
    expect(page.workflows.map((workflow) => workflow.metadata.name)).toEqual([
      "Complexity budget review",
    ]);
  });
});
