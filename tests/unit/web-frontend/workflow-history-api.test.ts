import { afterEach, expect, test } from "@jest/globals";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import {
  ApiClientError,
  MoiraApiClient,
} from "../../../packages/web-frontend/src/services/api-client";

const originalAdapter = axios.defaults.adapter;
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

test.each([
  ["550e8400-e29b-41d4-a716-446655440000", "/workflows/by-id/550e8400-e29b-41d4-a716-446655440000"],
  ["my-owner/history", "/workflows/by-reference/my-owner/history"],
  ["history", "/workflows/by-slug/history"],
])(
  "workflow history routes %s explicitly and keeps snapshot/write revisions distinct",
  async (identifier, basePath) => {
    const requests: InternalAxiosRequestConfig[] = [];
    const snapshots = [{ revision: 9, size: 7, preview: "graph", authorId: "owner", createdAt: 1 }];
    const diff = { from: 4, to: 9, parts: [{ value: "graph", added: true }] };
    const restored = {
      workflowId: "550e8400-e29b-41d4-a716-446655440000",
      revision: 3,
      historyRevision: 10,
      restoredFrom: 4,
    };
    axios.defaults.adapter = async (config) => {
      requests.push(config);
      const data = config.url?.endsWith("history")
        ? { revisions: snapshots }
        : config.url?.endsWith("revisions/4")
          ? { revision: 4, content: "historical graph" }
          : config.url?.endsWith("compare")
            ? diff
            : restored;
      return { config, status: 200, statusText: "OK", headers: {}, data: { success: true, data } };
    };
    const client = new MoiraApiClient();
    expect(await client.getWorkflowHistory(identifier)).toEqual(snapshots);
    expect(await client.readWorkflowRevision(identifier, 4)).toBe("historical graph");
    expect(await client.compareWorkflowRevisions(identifier, 4, 9)).toEqual(diff);
    expect(await client.rollbackWorkflow(identifier, 4, 2)).toEqual(restored);
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ["get", `${basePath}/history`],
      ["get", `${basePath}/revisions/4`],
      ["get", `${basePath}/compare`],
      ["post", `${basePath}/rollback`],
    ]);
    expect(requests[2].params).toEqual({ from: 4, to: 9 });
    expect(JSON.parse(requests[3].data)).toEqual({ revision: 4, expectedRevision: 2 });
    await client.getWorkflow(identifier);
    expect(requests[4].url).toBe(
      `/workflows/${identifier.split("/").map(encodeURIComponent).join("/")}`,
    );
  },
);

test("restore preserves an authoritative conflict message and current write token", async () => {
  axios.defaults.adapter = async (config) => {
    const response = {
      config,
      status: 409,
      statusText: "Conflict",
      headers: {},
      data: {
        success: false,
        error: {
          code: "WORKFLOW_REVISION_CONFLICT",
          message: "Workflow changed elsewhere",
          details: { currentRevision: 8 },
        },
      },
    };
    throw new AxiosError("Conflict", "ERR_BAD_REQUEST", config, undefined, response);
  };
  try {
    await new MoiraApiClient().rollbackWorkflow("550e8400-e29b-41d4-a716-446655440000", 4, 2);
    throw new Error("Expected conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      message: "Workflow changed elsewhere",
      code: "WORKFLOW_REVISION_CONFLICT",
      status: 409,
      details: { currentRevision: 8 },
    });
  }
});
