/** @jest-environment jsdom */
/**
 * The page-local data store behind navigation without flicker: a pending refetch keeps the
 * previous value, an error keeps it and exposes the message, a stale response never overwrites
 * a newer one, and a null key clears the value.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import axios from "axios";
import { MoiraApiClient } from "../../../packages/web-frontend/src/services/api-client.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useResource } from "../../../packages/web-frontend/src/hooks/useResource.js";
import {
  observeReadSession,
  suspendReadSession,
} from "../../../packages/web-frontend/src/services/read-scope.js";
const originalAdapter = axios.defaults.adapter;
afterEach(() => {
  axios.defaults.adapter = originalAdapter;
  observeReadSession(null, null);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useResource", () => {
  test("a public anonymous fetcher remains readable during an anonymous authentication attempt", async () => {
    observeReadSession(null, null);
    let calls = 0;
    const { result } = renderHook(() =>
      useResource("public-invite", async () => {
        calls++;
        return "public invite information";
      }),
    );
    await act(async () => {});
    expect(result.current.data).toBe("public invite information");
    await act(async () => suspendReadSession());
    expect(calls).toBe(2);
    expect(result.current.data).toBe("public invite information");
    expect(result.current.pending).toBe(false);
  });
  test("resource refresh bypasses the retained API validator while normal warm reads validate it", async () => {
    observeReadSession("refresh-owner", "refresh-session");
    const validators: unknown[] = [];
    axios.defaults.adapter = async (config) => {
      const validator = config.headers.get("If-None-Match");
      validators.push(validator);
      return {
        config,
        status: validator ? 304 : 200,
        statusText: "OK",
        headers: { etag: 'W/"notes"' },
        data: validator ? "" : { success: true, data: { notes: [], total: 1, allTags: [] } },
      };
    };
    const client = new MoiraApiClient();
    const { result } = renderHook(() => useResource("notes", () => client.getNotes()));
    await waitFor(() => expect(result.current.data?.total).toBe(1));
    await client.getNotes();
    await act(async () => result.current.refresh());
    expect(validators).toEqual([undefined, 'W/"notes"', undefined]);
    expect(result.current.data?.total).toBe(1);
    expect(result.current.dataKey).toBe("notes");
  });
  test("account switch hides held data and ignores the old pending response without changing the query key", async () => {
    observeReadSession("first-owner", "first-session");
    const calls: Array<ReturnType<typeof deferred<string>>> = [];
    const keys: string[] = [];
    const { result } = renderHook(() =>
      useResource("unchanged-query", (key) => {
        keys.push(key);
        const call = deferred<string>();
        calls.push(call);
        return call.promise;
      }),
    );
    await act(async () => calls[0].resolve("first owner's private data"));
    await act(async () => {
      void result.current.refresh();
    });
    act(() => observeReadSession("second-owner", "second-session"));
    expect(result.current.data).toBeUndefined();
    expect(result.current.dataKey).toBeNull();
    await act(async () => calls[1].resolve("late private data"));
    expect(result.current.data).toBeUndefined();
    await act(async () => calls[2].resolve("second owner's data"));
    expect(result.current.data).toBe("second owner's data");
    expect(result.current.dataKey).toBe("unchanged-query");
    expect(keys).toEqual(["unchanged-query", "unchanged-query", "unchanged-query"]);
  });
  test("a refetch keeps the previous value and reports pending until the new one arrives", async () => {
    const calls: Array<ReturnType<typeof deferred<string>>> = [];
    const fetcher = () => {
      const call = deferred<string>();
      calls.push(call);
      return call.promise;
    };
    const { result } = renderHook(() => useResource<string>("a", fetcher));
    // First load: nothing to show yet.
    expect(result.current.data).toBeUndefined();
    expect(result.current.pending).toBe(true);
    await act(async () => calls[0].resolve("first"));
    expect(result.current.data).toBe("first");
    expect(result.current.pending).toBe(false);

    await act(async () => {
      void result.current.refresh();
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.data).toBe("first");
    await act(async () => calls[1].resolve("second"));
    expect(result.current.data).toBe("second");
    expect(result.current.pending).toBe(false);
  });

  test("a failed refetch keeps the value and exposes the error; the next success clears it", async () => {
    const calls: Array<ReturnType<typeof deferred<number>>> = [];
    const fetcher = () => {
      const call = deferred<number>();
      calls.push(call);
      return call.promise;
    };
    const { result } = renderHook(() => useResource<number>("k", fetcher));
    await act(async () => calls[0].resolve(1));
    await act(async () => {
      void result.current.refresh();
    });
    await act(async () => calls[1].reject(new Error("offline")));
    expect(result.current.data).toBe(1);
    expect(result.current.error).toBe("offline");
    expect(result.current.pending).toBe(false);
    await act(async () => {
      void result.current.refresh();
    });
    await act(async () => calls[2].resolve(2));
    expect(result.current.data).toBe(2);
    expect(result.current.error).toBeNull();
  });

  test("a key change keeps the old value until the new key resolves, and a stale response is dropped", async () => {
    const calls = new Map<string, ReturnType<typeof deferred<string>>>();
    const fetcher = (key: string) => {
      const call = deferred<string>();
      calls.set(key, call);
      return call.promise;
    };
    const { result, rerender } = renderHook(({ key }) => useResource<string>(key, fetcher), {
      initialProps: { key: "a" as string | null },
    });
    await act(async () => calls.get("a")!.resolve("A"));
    rerender({ key: "b" });
    expect(result.current.data).toBe("A");
    expect(result.current.dataKey).toBe("a");
    expect(result.current.pending).toBe(true);
    rerender({ key: "c" });
    // "b" resolving after "c" was requested must not win.
    await act(async () => calls.get("b")!.resolve("B"));
    expect(result.current.data).toBe("A");
    await act(async () => calls.get("c")!.resolve("C"));
    await waitFor(() => expect(result.current.data).toBe("C"));
    expect(result.current.dataKey).toBe("c");
    expect(result.current.pending).toBe(false);

    rerender({ key: null });
    expect(result.current.data).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  test("a new key that fails stops pending with the error, so a page can show it instead of a loader", async () => {
    const calls = new Map<string, ReturnType<typeof deferred<string>>>();
    const fetcher = (key: string) => {
      const call = deferred<string>();
      calls.set(key, call);
      return call.promise;
    };
    const { result, rerender } = renderHook(({ key }) => useResource<string>(key, fetcher), {
      initialProps: { key: "a" },
    });
    await act(async () => calls.get("a")!.resolve("A"));
    rerender({ key: "b" });
    expect(result.current.pending).toBe(true);
    await act(async () => calls.get("b")!.reject(new Error("gone")));
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBe("gone");
    expect(result.current.dataKey).toBe("a");
  });

  test("update before the initial result does not invent data or cancel its pending read", async () => {
    const initial = deferred<{ approved: boolean }>();
    const { result } = renderHook(() => useResource("user", () => initial.promise));
    act(() => result.current.update(() => ({ approved: true })));
    expect(result.current.data).toBeUndefined();
    expect(result.current.pending).toBe(true);
    await act(async () => initial.resolve({ approved: false }));
    expect(result.current.data).toEqual({ approved: false });
    expect(result.current.pending).toBe(false);
  });

  test("a confirmed update preserves unrelated fields and supersedes a late refresh response", async () => {
    const calls: Array<ReturnType<typeof deferred<{ approved: boolean; name: string }>>> = [];
    const { result } = renderHook(() =>
      useResource("user", () => {
        const call = deferred<{ approved: boolean; name: string }>();
        calls.push(call);
        return call.promise;
      }),
    );
    await act(async () => calls[0].resolve({ approved: false, name: "Held name" }));
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    act(() => result.current.update((user) => ({ ...user, approved: true })));
    expect(result.current.data).toEqual({ approved: true, name: "Held name" });
    expect(result.current.pending).toBe(false);
    await act(async () => {
      calls[1].resolve({ approved: false, name: "Late old name" });
      await refresh;
    });
    expect(result.current.data).toEqual({ approved: true, name: "Held name" });
  });

  test("an old key's update cannot alter a held result or the newly accepted key", async () => {
    const calls = new Map<string, ReturnType<typeof deferred<string>>>();
    const { result, rerender } = renderHook(
      ({ key }) =>
        useResource(key, (target) => {
          const call = deferred<string>();
          calls.set(target, call);
          return call.promise;
        }),
      { initialProps: { key: "a" } },
    );
    await act(async () => calls.get("a")!.resolve("A"));
    const oldUpdate = result.current.update;
    rerender({ key: "b" });
    act(() => oldUpdate(() => "wrong old key"));
    expect(result.current.data).toBe("A");
    expect(result.current.pending).toBe(true);
    await act(async () => calls.get("b")!.resolve("B"));
    act(() => oldUpdate(() => "wrong old key"));
    expect(result.current.data).toBe("B");
    expect(result.current.dataKey).toBe("b");
  });

  test("a former owner's update cannot change the replacement owner's accepted data", async () => {
    observeReadSession("owner-a", "session-a");
    const calls: Array<ReturnType<typeof deferred<string>>> = [];
    const { result } = renderHook(() =>
      useResource("same-key", () => {
        const call = deferred<string>();
        calls.push(call);
        return call.promise;
      }),
    );
    await act(async () => calls[0].resolve("A private result"));
    const oldUpdate = result.current.update;
    act(() => observeReadSession("owner-b", "session-b"));
    act(() => oldUpdate(() => "wrong owner"));
    expect(result.current.data).toBeUndefined();
    await act(async () => calls[1].resolve("B private result"));
    act(() => oldUpdate(() => "wrong owner"));
    expect(result.current.data).toBe("B private result");
  });
});
