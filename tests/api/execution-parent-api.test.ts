import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";
import { callMCPToolRaw, createAuthenticatedMCPClient, signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

function processId(text: string): string {
  const id = text.match(/Process ID: ([a-f0-9-]+)/)?.[1];
  if (!id) throw new Error(`Process ID missing from response: ${text}`);
  return id;
}

describe("execution parent API", () => {
  let cookie: string;
  let cleanup: () => Promise<void>;
  let childId: string;
  let parentId: string;
  let replacementId: string;

  beforeAll(async () => {
    const credentials = getAdminCredentials();
    cookie = await signInUser(BASE_URL, credentials.email, credentials.password);
    const authenticated = await createAuthenticatedMCPClient(credentials);
    cleanup = authenticated.cleanup;
    const start = () =>
      callMCPToolRaw(authenticated.client, "start", {
        workflowId: "moira/todo-list",
        parentExecutionId: "none",
        skipTelegramCheck: true,
      });
    childId = processId(await start());
    parentId = processId(await start());
    replacementId = processId(await start());
  });

  afterAll(async () => {
    await cleanup();
  });

  async function detail() {
    const response = await fetch(`${BASE_URL}/api/executions/${childId}`, {
      headers: { Cookie: `better-auth.session_token=${cookie}` },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      data: { execution: { parentExecutionId: string | null; revision: number } };
    };
  }

  async function setParent(parentExecutionId: string, expectedRevision: number) {
    return fetch(`${BASE_URL}/api/executions/${childId}/parent`, {
      method: "POST",
      headers: {
        Cookie: `better-auth.session_token=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ parentExecutionId, expectedRevision }),
    });
  }

  test("attach, idempotent repeat, replace, detach, and stale rejection share revision semantics", async () => {
    const initial = (await detail()).data.execution;

    const attached = await setParent(parentId, initial.revision);
    expect(attached.status).toBe(200);
    const attachedBody = (await attached.json()) as {
      data: { parentExecutionId: string; revision: number };
    };
    expect(attachedBody.data).toEqual({
      executionId: childId,
      parentExecutionId: parentId,
      revision: initial.revision + 1,
    });

    const repeated = await setParent(parentId, initial.revision);
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as { data: { revision: number } }).data.revision).toBe(
      initial.revision + 1,
    );

    const replaced = await setParent(replacementId, initial.revision + 1);
    expect(replaced.status).toBe(200);
    expect((await detail()).data.execution).toMatchObject({
      parentExecutionId: replacementId,
      revision: initial.revision + 2,
    });

    const stale = await setParent(parentId, initial.revision + 1);
    expect(stale.status).toBe(409);

    const detached = await setParent("none", initial.revision + 2);
    expect(detached.status).toBe(200);
    expect((await detail()).data.execution).toMatchObject({
      parentExecutionId: null,
      revision: initial.revision + 3,
    });
  });
});
