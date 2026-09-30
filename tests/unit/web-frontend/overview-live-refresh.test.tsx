/** @jest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { useResource } from "../../../packages/web-frontend/src/hooks/useResource";
import {
  PAGE_REFETCH_MS,
  useLiveOverview,
} from "../../../packages/web-frontend/src/components/overview/useLiveOverview";
import type {
  LiveDependencies,
  StreamLike,
} from "../../../packages/web-frontend/src/components/overview/liveConnection";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

function dependencies() {
  jest.useFakeTimers();
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const stream: StreamLike = {
    onopen: null,
    onerror: null,
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    close: () => undefined,
  };
  const deps: LiveDependencies = {
    openStream: () => stream,
    pollChanges: async () => ({ reset: false, events: [], lastSeq: 0 }),
    locks: null,
    channel: null,
    isVisible: () => true,
    onVisibilityChange: () => () => undefined,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    now: Date.now,
    tabId: "only",
  };
  let seq = 0;
  const change = (executionId: string, kind: string) => {
    listeners.get("change")!({
      lastEventId: String(++seq),
      data: JSON.stringify({ executionId, kind }),
    } as MessageEvent);
  };
  return { change, deps };
}

function connect(refetchPage = jest.fn<() => Promise<void>>().mockResolvedValue(undefined)) {
  const { change, deps } = dependencies();
  const hook = renderHook(() => {
    useLiveOverview({ refetchPage, removeRun: () => undefined }, () => deps);
  });
  return { change, refetchPage, unmount: hook.unmount };
}

describe("the overview refreshes the server's tree query", () => {
  test.each(["activity", "meta"])("%s outside the visible page requests a new page", (kind) => {
    const { change, refetchPage } = connect();
    act(() => change("outside-current-page", kind));
    act(() => jest.advanceTimersByTime(PAGE_REFETCH_MS));
    expect(refetchPage).toHaveBeenCalledTimes(1);
  });

  test("a burst affecting more than one hundred runs reloads every tree in one page request", () => {
    const { change, refetchPage } = connect();
    act(() => {
      for (let index = 0; index < 150; index++) change(`child-${index}`, "activity");
    });
    act(() => jest.advanceTimersByTime(PAGE_REFETCH_MS));
    expect(refetchPage).toHaveBeenCalledTimes(1);
  });

  test("continuous events cannot postpone a page refresh indefinitely", () => {
    const { change, refetchPage } = connect();
    act(() => change("first", "status"));
    for (let index = 0; index < 6; index++) {
      act(() => jest.advanceTimersByTime(100));
      act(() => change(`later-${index}`, "status"));
    }
    expect(refetchPage).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(PAGE_REFETCH_MS - 600));
    expect(refetchPage).toHaveBeenCalledTimes(1);
  });

  test("slow fetched state is applied during continuous events, followed by one coalesced refresh", async () => {
    let requests = 0;
    let inFlight = 0;
    let maximumInFlight = 0;
    const fetcher = () => {
      const value = ++requests;
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      return new Promise<number>((resolve) => {
        setTimeout(() => {
          inFlight--;
          resolve(value);
        }, 1400);
      });
    };
    const { change, deps } = dependencies();
    const { result } = renderHook(() => {
      const resource = useResource("current-page", fetcher);
      useLiveOverview({ refetchPage: resource.refresh, removeRun: () => undefined }, () => deps);
      return resource.data;
    });
    // Allow the initial page to load before the stream begins changing it.
    await act(async () => {
      jest.advanceTimersByTime(1400);
    });
    expect(result.current).toBe(1);
    act(() => change("root", "activity"));
    // More events arrive every 100 ms, faster than either a request or the refresh delay.
    for (let index = 0; index < 21; index++) {
      await act(async () => {
        jest.advanceTimersByTime(100);
      });
      act(() => change(`child-${index}`, "activity"));
    }
    expect(result.current).toBe(2);
    for (let index = 21; index < 42; index++) {
      await act(async () => {
        jest.advanceTimersByTime(100);
      });
      act(() => change(`child-${index}`, "activity"));
    }
    expect(result.current).toBe(3);
    expect(requests).toBe(3);
    expect(maximumInFlight).toBe(1);
  });

  test("unmounting while a refresh is pending prevents its dirty follow-up", async () => {
    let finish!: () => void;
    const refetch = jest.fn<() => Promise<void>>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { change, unmount } = connect(refetch);
    act(() => change("root", "activity"));
    act(() => jest.advanceTimersByTime(PAGE_REFETCH_MS));
    act(() => change("child", "meta"));
    unmount();
    await act(async () => {
      finish();
    });
    act(() => jest.advanceTimersByTime(PAGE_REFETCH_MS));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
