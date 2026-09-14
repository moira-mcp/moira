/**
 * A page-local data store that keeps its last good value while a new fetch is pending.
 *
 * `useResource(key, fetcher)` fetches when `key` changes and on `refresh()`. Throughout a pending
 * fetch `data` keeps the previous value, so a page that already has content never has to blank
 * it: it renders the old picture with a slim pending indicator until the new one arrives. An
 * error keeps `data` too and exposes the message; a response from an older request that
 * resolves after a newer one is dropped; a `null` key means nothing to fetch and clears the
 * value. The first fetch of a page is the one place where `data` is undefined while `pending`
 * is true — the only state in which a full-page loader belongs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorUtils } from "../services/api-client";

export interface Resource<T> {
  /** The last successfully fetched value; undefined before the first success or after a null key. */
  data: T | undefined;
  /** The key `data` was fetched for; differs from the current key while a change is pending. */
  dataKey: string | null;
  /** A fetch is in flight (first load or a refetch). */
  pending: boolean;
  /** The last fetch failed with this message; cleared by the next success. */
  error: string | null;
  /** Fetch the current key again, keeping `data` until the response arrives. */
  refresh: () => Promise<void>;
}

export function useResource<T>(
  key: string | null,
  fetcher: (key: string) => Promise<T>,
  describeError: (error: unknown) => string = defaultDescribeError,
): Resource<T> {
  const [state, setState] = useState<{
    data: T | undefined;
    dataKey: string | null;
    pending: boolean;
    error: string | null;
  }>({ data: undefined, dataKey: null, pending: key !== null, error: null });
  const requestRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const describeRef = useRef(describeError);
  describeRef.current = describeError;

  const load = useCallback(async (target: string) => {
    const request = ++requestRef.current;
    setState((previous) => ({ ...previous, pending: true }));
    try {
      const value = await fetcherRef.current(target);
      if (request !== requestRef.current) return;
      setState({ data: value, dataKey: target, pending: false, error: null });
    } catch (caught) {
      if (request !== requestRef.current) return;
      setState((previous) => ({
        ...previous,
        pending: false,
        error: describeRef.current(caught),
      }));
    }
  }, []);

  const startedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    startedKeyRef.current = key;
    if (key === null) {
      requestRef.current += 1;
      setState({ data: undefined, dataKey: null, pending: false, error: null });
      return;
    }
    void load(key);
  }, [key, load]);

  const refresh = useCallback(() => (key === null ? Promise.resolve() : load(key)), [key, load]);

  // A key whose request has not started yet is pending from the first render, not from the
  // effect that starts it: a consumer never sees a frame where the previous key's value looks
  // current for the new key. Once the request has started (or failed) the state speaks.
  const pending = state.pending || (key !== null && startedKeyRef.current !== key);
  return {
    data: state.data,
    dataKey: state.dataKey,
    pending,
    error: state.error,
    refresh,
  };
}

function defaultDescribeError(error: unknown): string {
  return ApiErrorUtils.getUserFriendlyMessage(error);
}
