import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";
import { callMCPToolRaw, createAuthenticatedMCPClient, signInUser } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();

describe("execution reminders API", () => {
  let cookie: string;
  let cleanup: () => Promise<void>;
  let executionId: string;

  beforeAll(async () => {
    const credentials = getAdminCredentials();
    cookie = await signInUser(BASE_URL, credentials.email, credentials.password);
    const authenticated = await createAuthenticatedMCPClient(credentials);
    cleanup = authenticated.cleanup;
    const started = await callMCPToolRaw(authenticated.client, "start", {
      workflowId: "moira/todo-list",
      parentExecutionId: "none",
      skipTelegramCheck: true,
    });
    const id = started.match(/Process ID: ([a-f0-9-]+)/)?.[1];
    if (!id) throw new Error("Process ID missing");
    executionId = id;
  });

  afterAll(async () => cleanup());

  const headers = () => ({
    Cookie: `better-auth.session_token=${cookie}`,
    "Content-Type": "application/json",
  });

  test("add, idempotent retry, filter, update and cancel preserve revisioned history", async () => {
    const detail = await fetch(`${BASE_URL}/api/executions/${executionId}`, { headers: headers() });
    const initial = (await detail.json()) as { data: { execution: { revision: number } } };
    const created = await fetch(`${BASE_URL}/api/executions/${executionId}/reminders`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        text: "Open PR",
        idempotencyKey: "pr",
        expectedRevision: initial.data.execution.revision,
      }),
    });
    expect(created.status).toBe(200);
    const createdData = (await created.json()) as {
      data: { reminder: { id: string }; revision: number };
    };
    const repeated = await fetch(`${BASE_URL}/api/executions/${executionId}/reminders`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        text: "Open PR",
        idempotencyKey: "pr",
        expectedRevision: createdData.data.revision - 1,
      }),
    });
    expect(
      ((await repeated.json()) as { data: { changed: boolean; revision: number } }).data,
    ).toMatchObject({ changed: false, revision: createdData.data.revision });
    const listed = await fetch(
      `${BASE_URL}/api/executions/${executionId}/reminders?status=active&search=open`,
      { headers: headers() },
    );
    expect(
      ((await listed.json()) as { data: { reminders: unknown[] } }).data.reminders,
    ).toHaveLength(1);
    const updated = await fetch(
      `${BASE_URL}/api/executions/${executionId}/reminders/${createdData.data.reminder.id}`,
      {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          text: "Open and review PR",
          expectedRevision: createdData.data.revision,
        }),
      },
    );
    const updatedData = (await updated.json()) as { data: { revision: number } };
    const cancelled = await fetch(
      `${BASE_URL}/api/executions/${executionId}/reminders/${createdData.data.reminder.id}`,
      {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({ expectedRevision: updatedData.data.revision }),
      },
    );
    expect(cancelled.status).toBe(200);
    const cancelledList = await fetch(
      `${BASE_URL}/api/executions/${executionId}/reminders?status=cancelled`,
      { headers: headers() },
    );
    expect(
      (
        (await cancelledList.json()) as {
          data: { reminders: Array<{ text: string; status: string }> };
        }
      ).data.reminders,
    ).toEqual([expect.objectContaining({ text: "Open and review PR", status: "cancelled" })]);
  });
});
