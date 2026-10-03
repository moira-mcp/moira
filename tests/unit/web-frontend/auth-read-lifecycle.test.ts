import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import {
  getReadIdentity,
  getReadOwner,
} from "../../../packages/web-frontend/src/services/read-scope";

const originalFetch = globalThis.fetch;
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
const session = (userId: string, id: string) => ({
  user: { id: userId, email: `${userId}@example.test`, name: userId, emailVerified: true },
  session: {
    id,
    userId,
    token: `token-${id}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});

test("real Better Auth transport retires at sign-in dispatch and trusts only the subsequent authoritative session", async () => {
  let current = session("old-owner", "old-session");
  let dispatch!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    dispatch = resolve;
  });
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  let checked!: () => void;
  const checkedSession = new Promise<void>((resolve) => {
    checked = resolve;
  });
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).includes("sign-in")) {
      dispatch();
      return pending;
    }
    if (current.user.id === "new-owner") checked();
    return Response.json(current);
  });
  await authClient.$store.atoms.session.get().refetch();
  const oldOwner = getReadOwner();
  expect(getReadIdentity()).not.toBeNull();
  const signIn = authClient.signIn.email({ email: "new@example.test", password: "password" });
  await dispatched;
  expect(getReadIdentity()).toBeNull();
  current = session("new-owner", "new-session");
  finish(Response.json({ token: "new-token", user: current.user }));
  await signIn;
  await checkedSession;
  await authClient.$store.atoms.session.get().refetch();
  expect(getReadOwner()).not.toBe(oldOwner);
  expect(getReadIdentity()).not.toBeNull();
});

test("network-rejected auth attempt recovers through real uncached session recheck without changing ownership", async () => {
  const current = session("owner", "same-session");
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).includes("sign-in")) throw new Error("network disconnected");
    return Response.json(current);
  });
  await authClient.$store.atoms.session.get().refetch();
  const owner = getReadOwner();
  await expect(
    authClient.signIn.email({ email: "owner@example.test", password: "password" }),
  ).rejects.toThrow("network disconnected");
  await authClient.$store.atoms.session.get().refetch();
  expect(getReadOwner()).toBe(owner);
  expect(getReadIdentity()).not.toBeNull();
});

test("provider deferred renewal advances credential identity while retaining account ownership", async () => {
  const current = session("owner", "same-session");
  let due = false;
  let renewed = false;
  globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    if (init?.method === "POST") {
      renewed = true;
      current.session.updatedAt = new Date(Date.now() + 3_600_000).toISOString();
      current.session.expiresAt = new Date(Date.now() + 3_660_000).toISOString();
      return Response.json(current);
    }
    return Response.json(due ? { ...current, needsRefresh: true } : current);
  });
  await authClient.$store.atoms.session.get().refetch();
  const identity = getReadIdentity();
  const owner = getReadOwner();
  due = true;
  await authClient.$store.atoms.session.get().refetch();
  expect(renewed).toBe(true);
  expect(getReadIdentity()).not.toBe(identity);
  expect(getReadOwner()).toBe(owner);
});
