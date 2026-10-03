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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getReadOwner,
  getReadScopeVersion,
  isPrivateReadSuspended,
  retireReads,
  subscribeReadScope,
} from "../services/read-scope";
import { ApiErrorUtils } from "../services/api-client";
import { useLatestRequest } from "./useLatestRequest";

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
): Resource<T> & { update: (updateValue: (value: T) => T) => void } {
  const scope = useSyncExternalStore(subscribeReadScope, getReadScopeVersion, getReadScopeVersion);
  const owner = getReadOwner();
  const requestedKeyRef = useRef(key);
  requestedKeyRef.current = key;
  const readable = !isPrivateReadSuspended();
  const [state, setState] = useState<{
    owner: string;
    data: T | undefined;
    dataKey: string | null;
    pending: boolean;
    error: string | null;
  }>({ owner, data: undefined, dataKey: null, pending: key !== null, error: null });
  const beginRequest = useLatestRequest();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const describeRef = useRef(describeError);
  describeRef.current = describeError;

  const load = useCallback(
    async (target: string) => {
      const isCurrent = beginRequest();
      const capturedScope = getReadScopeVersion();
      const capturedOwner = getReadOwner();
      if (isPrivateReadSuspended()) {
        setState((previous) => ({ ...previous, pending: true }));
        return;
      }
      setState((previous) =>
        previous.owner === capturedOwner
          ? { ...previous, pending: true }
          : { owner: capturedOwner, data: undefined, dataKey: null, pending: true, error: null },
      );
      try {
        const value = await fetcherRef.current(target);
        if (!isCurrent() || capturedScope !== getReadScopeVersion() || isPrivateReadSuspended())
          return;
        setState({
          owner: capturedOwner,
          data: value,
          dataKey: target,
          pending: false,
          error: null,
        });
      } catch (caught) {
        if (!isCurrent() || capturedScope !== getReadScopeVersion() || isPrivateReadSuspended())
          return;
        setState((previous) => ({
          ...previous,
          pending: false,
          error: describeRef.current(caught),
        }));
      }
    },
    [beginRequest],
  );

  const startedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    startedKeyRef.current = key;
    if (key === null) {
      // A request still in flight for the previous key must not land
      beginRequest();
      setState({ owner, data: undefined, dataKey: null, pending: false, error: null });
      return;
    }
    void load(key);
  }, [key, load, beginRequest, scope, owner]);

  const refresh = useCallback(() => {
    retireReads();
    return key === null ? Promise.resolve() : load(key);
  }, [key, load]);

  // A confirmed mutation can publish the fields it returned without waiting for another read.
  // It belongs only to this accepted key and owner, and supersedes any older pending read.
  const update = useCallback(
    (updateValue: (value: T) => T) => {
      if (
        key === null ||
        requestedKeyRef.current !== key ||
        owner !== getReadOwner() ||
        isPrivateReadSuspended() ||
        state.owner !== owner ||
        state.dataKey !== key ||
        state.data === undefined
      )
        return;
      beginRequest();
      setState((previous) =>
        previous.owner === owner && previous.dataKey === key && previous.data !== undefined
          ? { ...previous, data: updateValue(previous.data), pending: false, error: null }
          : previous,
      );
    },
    [key, owner, state, beginRequest],
  );

  // A key whose request has not started yet is pending from the first render, not from the
  // effect that starts it: a consumer never sees a frame where the previous key's value looks
  // current for the new key. Once the request has started (or failed) the state speaks.
  const pending = state.pending || (key !== null && startedKeyRef.current !== key);
  return {
    data: state.owner === owner && readable ? state.data : undefined,
    dataKey: state.owner === owner && readable ? state.dataKey : null,
    pending: pending || (key !== null && (state.owner !== owner || !readable)),
    error: state.owner === owner && readable ? state.error : null,
    refresh,
    update,
  };
}

function defaultDescribeError(error: unknown): string {
  return ApiErrorUtils.getUserFriendlyMessage(error);
}
