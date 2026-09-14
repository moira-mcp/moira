/** @jest-environment jsdom */
/**
 * The workflow detail hook on the last-good store: a refetch of the same workflow keeps it on
 * screen (`pending`, not `loading`), while a change of id is a first load again — the previous
 * workflow is never reported as current for the new id.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import { useWorkflowDetail } from "../../../packages/web-frontend/src/hooks/useWorkflowData";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("useWorkflowDetail", () => {
  afterEach(() => jest.restoreAllMocks());

  test("a refetch keeps the workflow current and pending; a new id is a first load that hides the old one", async () => {
    const calls = new Map<string, ReturnType<typeof deferred<unknown>>>();
    jest.spyOn(apiClient, "getWorkflow").mockImplementation((id: string) => {
      const call = deferred<unknown>();
      calls.set(id, call);
      return call.promise as never;
    });
    const { result, rerender } = renderHook(({ id }) => useWorkflowDetail(id), {
      initialProps: { id: "a" },
    });
    expect(result.current.loading).toBe(true);
    await act(async () => calls.get("a")!.resolve({ fileInfo: { id: "a" } }));
    expect(result.current.current).toBe(true);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      void result.current.refreshWorkflow();
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.current).toBe(true);
    expect(result.current.workflow).toEqual({ fileInfo: { id: "a" } });

    rerender({ id: "b" });
    expect(result.current.loading).toBe(true);
    expect(result.current.current).toBe(false);
    await act(async () => calls.get("b")!.resolve({ fileInfo: { id: "b" } }));
    expect(result.current.current).toBe(true);
    expect(result.current.workflow).toEqual({ fileInfo: { id: "b" } });
  });
});
