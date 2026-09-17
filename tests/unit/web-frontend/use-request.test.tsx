/** @jest-environment jsdom */
/**
 * `useRequest`: a request the interface makes to one of its own surfaces is a payload plus a token,
 * so the same request made twice is two requests (the answering effect runs again), and `null`
 * withdraws it.
 */

import { describe, expect, test } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import { useRequest } from "../../../packages/web-frontend/src/components/diagram/useRequest.js";

describe("useRequest", () => {
  test("starts empty, mints a fresh token for every request — the same payload included — and withdraws on null", () => {
    const { result } = renderHook(() => useRequest<{ nodeId: string }>());
    expect(result.current[0]).toBeNull();
    act(() => result.current[1]({ nodeId: "plan" }));
    expect(result.current[0]).toEqual({ nodeId: "plan", token: 1 });
    const first = result.current[0];
    act(() => result.current[1]({ nodeId: "plan" }));
    expect(result.current[0]).toEqual({ nodeId: "plan", token: 2 });
    expect(result.current[0]).not.toBe(first);
    act(() => result.current[1]({ nodeId: "review" }));
    expect(result.current[0]).toEqual({ nodeId: "review", token: 3 });
    act(() => result.current[1](null));
    expect(result.current[0]).toBeNull();
    // A request after a withdrawal starts the count again: nothing is pending to be outbid.
    act(() => result.current[1]({ nodeId: "plan" }));
    expect(result.current[0]).toEqual({ nodeId: "plan", token: 1 });
  });

  test("the sender keeps its identity across renders, so effects may depend on it", () => {
    const { result, rerender } = renderHook(() => useRequest<{ name: string }>());
    const send = result.current[1];
    act(() => send({ name: "x" }));
    rerender();
    expect(result.current[1]).toBe(send);
  });
});
