/** @jest-environment jsdom */
/**
 * The page-local data store behind navigation without flicker: a pending refetch keeps the
 * previous value, an error keeps it and exposes the message, a stale response never overwrites
 * a newer one, and a null key clears the value.
 */
import { describe, expect, test } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useResource } from "../../../packages/web-frontend/src/hooks/useResource.js";

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
});
