import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import {
  MoiraApiClient,
  setAuthErrorHandler,
} from "../../../packages/web-frontend/src/services/api-client";
import {
  getReadIdentity,
  observeReadCapabilities,
  observeReadSession,
} from "../../../packages/web-frontend/src/services/read-scope";

const originalAdapter = axios.defaults.adapter;
beforeEach(() => {
  observeReadSession("owner-a", "credential-a");
  observeReadCapabilities("unobserved", "user");
});
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  setAuthErrorHandler(null);
  observeReadSession(null, null);
});
function facts(id: string, blocked: boolean) {
  return {
    id,
    email: `${id}@example.test`,
    handle: null,
    isAdmin: blocked,
    passwordResetRequired: blocked,
    blocked,
    emailVerified: true,
    approvedAt: null,
    accountApproved: true,
    accountApprovalRequired: false,
  };
}
function reply(config: InternalAxiosRequestConfig, user: ReturnType<typeof facts>) {
  return {
    config,
    status: 200,
    statusText: "OK",
    headers: {},
    data: { success: true, data: user },
  };
}

test.each(["different-account", "renewed-credential", "newer-capabilities"])(
  "late prior %s user info may return its DTO but cannot overwrite current capability identity",
  async (change) => {
    let finish!: (response: ReturnType<typeof reply>) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let heldConfig!: InternalAxiosRequestConfig;
    let first = true;
    const currentId = change === "different-account" ? "owner-b" : "owner-a";
    axios.defaults.adapter = async (config) => {
      if (first) {
        first = false;
        heldConfig = config;
        start();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return reply(config, facts(currentId, false));
    };
    const client = new MoiraApiClient();
    const previous = client.getUserInfo();
    await started;
    observeReadSession(
      currentId,
      change === "newer-capabilities" ? "credential-a" : "credential-b",
    );
    const unobserved = getReadIdentity();
    const current = await client.getUserInfo();
    expect(current).toEqual(facts(currentId, false));
    expect(getReadIdentity()).not.toBe(unobserved);
    const currentIdentity = getReadIdentity();
    finish(reply(heldConfig, facts("owner-a", true)));
    expect(await previous).toEqual(facts("owner-a", true));
    expect(getReadIdentity()).toBe(currentIdentity);
  },
);

test("request authority is captured at call dispatch before a later account change in the same turn", async () => {
  const handler = jest.fn();
  setAuthErrorHandler(handler);
  axios.defaults.adapter = async (config) => {
    throw new AxiosError("refused", "ERR_BAD_REQUEST", config, undefined, {
      config,
      status: 403,
      statusText: "Forbidden",
      headers: {},
      data: { success: false, error: { code: "FORBIDDEN", message: "Former owner denied" } },
    });
  };
  const client = new MoiraApiClient();
  const previous = client.getUserInfo();
  observeReadSession("owner-b", "credential-b");
  await expect(previous).rejects.toThrow("Failed to get user info");
  expect(handler).not.toHaveBeenCalled();
});

test("a newer same-credential user-info observation still publishes when the previous reply settles first", async () => {
  const replies: Array<{
    config: InternalAxiosRequestConfig;
    finish: (response: ReturnType<typeof reply>) => void;
  }> = [];
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  axios.defaults.adapter = async (config) => {
    if (replies.length === 2) return reply(config, facts("owner-a", true));
    return new Promise((resolve) => {
      replies.push({ config, finish: resolve });
      if (replies.length === 2) start();
    });
  };
  const client = new MoiraApiClient();
  const previous = client.getUserInfo();
  const latest = client.getUserInfo();
  await started;
  replies[0].finish(reply(replies[0].config, facts("owner-a", false)));
  expect(await previous).toEqual(facts("owner-a", false));
  replies[1].finish(reply(replies[1].config, facts("owner-a", true)));
  expect(await latest).toEqual(facts("owner-a", true));
  const observed = getReadIdentity();
  expect(await client.getUserInfo()).toEqual(facts("owner-a", true));
  expect(getReadIdentity()).toBe(observed);
});

test("a conditional read retired before its queued dispatch cannot borrow the next account's authority", async () => {
  const handler = jest.fn();
  setAuthErrorHandler(handler);
  let dispatches = 0;
  axios.defaults.adapter = async (config) => {
    dispatches++;
    throw new AxiosError("refused", "ERR_BAD_REQUEST", config, undefined, {
      config,
      status: 403,
      statusText: "Forbidden",
      headers: {},
      data: { success: false, error: { code: "FORBIDDEN", message: "Retired request denied" } },
    });
  };
  const client = new MoiraApiClient();
  const previous = client.getNotes();
  observeReadSession("owner-b", "credential-b");
  await expect(previous).rejects.toThrow("Failed to get notes");
  expect(dispatches).toBe(0);
  expect(handler).not.toHaveBeenCalled();
});

test.each([401, 403])(
  "a late previous-owner %i cannot retire the current owner's pending successful conditional read",
  async (status) => {
    let deny!: () => void;
    let finish!: () => void;
    let oldStarted!: () => void;
    let currentStarted!: () => void;
    const startedOld = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    const startedCurrent = new Promise<void>((resolve) => {
      currentStarted = resolve;
    });
    axios.defaults.adapter = async (config) => {
      if (config.url === "/user/me")
        return new Promise((_, reject) => {
          deny = () =>
            reject(
              new AxiosError("refused", "ERR_BAD_REQUEST", config, undefined, {
                config,
                status,
                statusText: "Forbidden",
                headers: {},
                data: {
                  success: false,
                  error: { code: "FORBIDDEN", message: "Previous owner denied" },
                },
              }),
            );
          oldStarted();
        });
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            config,
            status: 200,
            statusText: "OK",
            headers: { etag: 'W/"owner-b"' },
            data: {
              success: true,
              data: { notes: [{ preview: "Current owner-b data" }], total: 1, allTags: [] },
            },
          });
        currentStarted();
      });
    };
    const client = new MoiraApiClient();
    const previous = client.getUserInfo();
    const rejected = expect(previous).rejects.toThrow("Failed to get user info");
    await startedOld;
    observeReadSession("owner-b", "credential-b");
    const current = client.getNotes();
    await startedCurrent;
    deny();
    await rejected;
    finish();
    expect((await current).notes[0].preview).toBe("Current owner-b data");
  },
);
