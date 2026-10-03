import { afterEach, expect, test } from "@jest/globals";
import axios from "axios";
import { MoiraApiClient } from "../../../packages/web-frontend/src/services/api-client";

const originalAdapter = axios.defaults.adapter;
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
});

test("workflow, audit and deleted-list requests transmit epoch-zero date bounds and omit absent dates", async () => {
  const requests: URL[] = [];
  axios.defaults.adapter = async (config) => {
    requests.push(new URL(config.url!, "https://example.test"));
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: { success: true, data: { workflows: [], entries: [], total: 0, limit: 20, offset: 0 } },
    };
  };
  const client = new MoiraApiClient();
  for (const read of [
    (bounds: { fromDate?: number; toDate?: number }) => client.getAdminWorkflows(bounds),
    (bounds: { fromDate?: number; toDate?: number }) => client.getAuditLogs(bounds),
    (bounds: { fromDate?: number; toDate?: number }) => client.getDeletedWorkflows(bounds),
  ]) {
    await read({ fromDate: 0, toDate: 0 });
    const bounded = requests.at(-1)!;
    expect(bounded.searchParams.get("fromDate")).toBe("0");
    expect(bounded.searchParams.get("toDate")).toBe("0");
    await read({});
    const unbounded = requests.at(-1)!;
    expect(unbounded.searchParams.has("fromDate")).toBe(false);
    expect(unbounded.searchParams.has("toDate")).toBe(false);
  }
  expect([...new Set(requests.map((request) => request.pathname))].sort()).toEqual([
    "/admin/audit-log",
    "/admin/workflows",
    "/admin/workflows/deleted",
  ]);
});
