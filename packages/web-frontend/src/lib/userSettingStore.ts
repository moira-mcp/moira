/**
 * An in-page copy of one user setting that the interface edits optimistically: every component that
 * reads the setting sees the same copy, and a change made anywhere is seen everywhere at once.
 *
 * A change is a function of the stored value. It is shown immediately and saved; saves run one after
 * another, and each reads the stored value just before writing and applies only its own change, so a
 * change made meanwhile on another tab or device is never undone. A change the server refuses, or a
 * save that fails, is taken back on the page and rejects the returned promise, for the caller to
 * report. The copy belongs to the signed-in user: another account reads its own afresh.
 */

import { useEffect, useSyncExternalStore } from "react";
import { useSession } from "../auth/better-auth-client";
import { apiClient, ApiErrorUtils } from "../services/api-client";
import { retireReads } from "../services/read-scope";

export type SettingChange<T> = (value: T) => T;

export interface UserSettingStore<T> {
  /** The value as this page knows it; `loaded` is false until it is known. */
  useValue(): {
    loaded: boolean;
    value: T | null;
    accepted: boolean;
    pending: boolean;
    error: string | null;
    refresh: () => Promise<void>;
  };
  /** Apply a change: seen at once, saved against the stored value, undone if refused. */
  change(change: SettingChange<T>): Promise<void>;
  /** Forget the in-page copy; for tests that sign in as another user. */
  reset(): void;
}

export interface UserSettingStoreOptions<T> {
  /** The stored value as this build understands it; anything unexpected reads as a default. */
  parse: (stored: unknown) => T;
  /** The value to write; the parsed form by default. */
  serialize?: (value: T) => unknown;
  /**
   * What the page shows when the stored value cannot be read. Absent: the value stays unknown and
   * nothing that depends on it is shown; the next mount asks again.
   */
  whenUnreadable?: () => T;
}

/** The key of a reader whose session is not known; the server answers for whoever is signed in. */
const ANONYMOUS = "";

export function createUserSettingStore<T>(
  key: string,
  { parse, serialize = (value) => value, whenUnreadable }: UserSettingStoreOptions<T>,
): UserSettingStore<T> {
  let state: {
    userId: string | null;
    value: T | null;
    accepted: boolean;
    pending: boolean;
    error: string | null;
  } = { userId: null, value: null, accepted: false, pending: false, error: null };
  let loadingFor: string | null = null;
  let currentRead: object | null = null;
  const listeners = new Set<() => void>();
  /** Changes shown on this page whose save has not finished, in the order they were made. */
  const pending: SettingChange<T>[] = [];
  /** Saves run one after another. */
  let saving: Promise<void> = Promise.resolve();
  /** The value as last read from or written to the server, under the pending changes. */
  let stored: T | null = null;

  const publish = (next: Pick<typeof state, "userId" | "value"> & Partial<typeof state>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };
  const withPending = (base: T): T => pending.reduce((value, change) => change(value), base);

  const load = (userId: string, force = false): Promise<void> => {
    if (!force && loadingFor === userId) return Promise.resolve();
    if (state.userId !== userId) {
      // Another account: nothing of the previous one's value or pending changes applies.
      pending.length = 0;
      stored = null;
    }
    const sameOwner = state.userId === userId;
    const read = {};
    currentRead = read;
    loadingFor = userId;
    publish({
      userId,
      value: sameOwner ? state.value : null,
      accepted: sameOwner && state.accepted,
      pending: true,
      error: null,
    });
    return apiClient.getUserSettings().then(
      (settings) => {
        if (loadingFor !== userId || currentRead !== read) return;
        stored = parse(settings[key]);
        publish({
          userId,
          value: withPending(stored),
          accepted: true,
          pending: false,
          error: null,
        });
      },
      (error: unknown) => {
        if (loadingFor !== userId || currentRead !== read) return;
        loadingFor = null;
        if (!state.accepted) stored = whenUnreadable ? whenUnreadable() : null;
        publish({
          userId,
          value: stored === null ? null : withPending(stored),
          pending: false,
          error: ApiErrorUtils.getUserFriendlyMessage(error),
        });
      },
    );
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const change = (change: SettingChange<T>): Promise<void> => {
    const owner = state.userId;
    pending.push(change);
    // A value not known yet stays unknown until the save has read the server's: showing a change
    // applied to a guessed default would tell the page things about the reader that may be false.
    publish({ userId: owner, value: stored === null ? null : withPending(stored) });
    const settle = () => {
      const index = pending.indexOf(change);
      if (index >= 0) pending.splice(index, 1);
    };
    const run = saving.then(async () => {
      try {
        const current = parse((await apiClient.getUserSettings())[key]);
        const next = change(current);
        const result = await apiClient.updateUserSettings({ [key]: serialize(next) });
        const refused = result.refused.find((entry) => entry.key === key);
        if (refused) throw new Error(refused.reason);
        settle();
        if (state.userId === owner) {
          stored = next;
          publish({ userId: owner, value: withPending(next), accepted: true, error: null });
        }
      } catch (error) {
        settle();
        if (state.userId === owner) {
          publish({ userId: owner, value: stored === null ? null : withPending(stored) });
        }
        throw error;
      }
    });
    saving = run.catch(() => undefined);
    return run;
  };

  const useValue = () => {
    // Pages that edit a user setting render behind the signed-in route, so the session is known
    // here; a change of account without a reload reads the new account's value.
    const { data: session } = useSession();
    const userId = session?.user?.id ?? ANONYMOUS;
    useEffect(() => {
      void load(userId);
    }, [userId]);
    const snapshot = useSyncExternalStore(subscribe, () => state);
    const current = snapshot.userId === userId;
    return {
      loaded: current && snapshot.value !== null,
      value: current ? snapshot.value : null,
      accepted: current && snapshot.accepted,
      pending: !current || snapshot.pending,
      error: current ? snapshot.error : null,
      refresh: () => {
        retireReads();
        return load(userId, true);
      },
    };
  };

  const reset = () => {
    loadingFor = null;
    currentRead = null;
    pending.length = 0;
    saving = Promise.resolve();
    stored = null;
    state = { userId: null, value: null, accepted: false, pending: false, error: null };
  };

  return { useValue, change, reset };
}
