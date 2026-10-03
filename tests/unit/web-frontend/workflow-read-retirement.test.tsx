/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { act, cleanup, renderHook } from "@testing-library/react";
import axios, { type InternalAxiosRequestConfig } from "axios";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { observeReadSession } from "../../../packages/web-frontend/src/services/read-scope";

const originalAdapter = axios.defaults.adapter;
const originalFetch = globalThis.fetch;
const originalReact = globalThis.React;
let dispatch: (config: InternalAxiosRequestConfig) => Promise<unknown>;
axios.defaults.adapter = async (config) => ({
  config,
  status: 200,
  statusText: "OK",
  headers: {},
  data: { success: true, data: await dispatch(config) },
});
const api = await import("../../../packages/web-frontend/src/services/api-client");
const client = new api.MoiraApiClient();
jest.unstable_mockModule("../../../packages/web-frontend/src/services/api-client", () => ({
  ...api,
  apiClient: client,
}));
const { useWorkflowList } =
  await import("../../../packages/web-frontend/src/hooks/useWorkflowData");
afterEach(() => {
  cleanup();
  axios.defaults.adapter = originalAdapter;
  globalThis.fetch = originalFetch;
  globalThis.React = originalReact;
  observeReadSession(null, null);
  jest.restoreAllMocks();
});

test("a passive workflow list recovers a mutation-retired HTTP200 through a fresh shared read", async () => {
  globalThis.React = React;
  globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      user: { id: "reader", email: "reader@example.test", name: "Reader", emailVerified: true },
      session: {
        id: "session",
        userId: "reader",
        token: "test-token",
        expiresAt: "2099-01-01",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    }),
  );
  await authClient.$store.atoms.session.get().refetch();
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (value: unknown) => void;
  let reads = 0;
  dispatch = async (config) => {
    if (config.method === "put") return { saved: { "tours.progress": true }, refused: [] };
    reads++;
    if (reads === 1) {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return { workflows: [{ id: "fresh" }], total: 1, lastScan: "fresh-source-scan" };
  };
  const { result } = renderHook(() => useWorkflowList());
  let load!: Promise<void>;
  act(() => {
    load = result.current.loadWorkflows({ limit: 20 });
  });
  await pending;
  await client.updateUserSettings({ "tours.progress": "next-step" });
  await act(async () => {
    finish({ workflows: [{ id: "retired" }], total: 1, lastScan: "old-source-scan" });
    await load;
  });
  expect(result.current.error).toBeNull();
  expect(result.current.workflows).toMatchObject({
    workflows: [{ id: "fresh" }],
    lastScan: "fresh-source-scan",
  });
  expect(result.current.loading).toBe(false);
  expect(reads).toBe(2);
  expect(result.current.acceptedFilters).toEqual({ limit: 20 });
});

test("a workflow response keeps its accepted filters while a newer query is pending or failed", async () => {
  globalThis.React = React;
  axios.defaults.adapter = async (config) => ({
    config,
    status: 200,
    statusText: "OK",
    headers: {},
    data: { success: true, data: await dispatch(config) },
  });
  globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      user: { id: "reader", email: "reader@example.test", name: "Reader", emailVerified: true },
      session: {
        id: "query-session",
        userId: "reader",
        token: "test-query-token",
        expiresAt: "2099-01-01",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    }),
  );
  await authClient.$store.atoms.session.get().refetch();
  let reject!: (error: unknown) => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  dispatch = async (config) => {
    if (new URL(config.url!, "https://example.test").searchParams.get("search") === "new query") {
      started();
      return new Promise((_yes, no) => {
        reject = no;
      });
    }
    return { workflows: [], total: 0, totalWorkflows: 0, lastScan: "accepted-empty" };
  };
  const { result } = renderHook(() => useWorkflowList());
  const oldQuery = { access: "mine" as const, limit: 8, offset: 8 };
  await act(async () => result.current.loadWorkflows(oldQuery));
  oldQuery.offset = 0;
  expect(result.current.acceptedFilters).toEqual({ access: "mine", limit: 8, offset: 8 });
  let next!: Promise<void>;
  act(() => {
    next = result.current.loadWorkflows({ access: "catalog", search: "new query", limit: 20 });
  });
  await pending;
  expect(result.current.workflows?.workflows).toEqual([]);
  expect(result.current.acceptedFilters).toEqual({ access: "mine", limit: 8, offset: 8 });
  await act(async () => {
    reject(new Error("source unavailable"));
    await next;
  });
  expect(result.current.error).not.toBeNull();
  expect(result.current.workflows?.lastScan).toBe("accepted-empty");
  expect(result.current.acceptedFilters).toEqual({ access: "mine", limit: 8, offset: 8 });
});
