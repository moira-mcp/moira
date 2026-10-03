import { useState } from "react";
import type { AnalyticsExclusions } from "@mcp-moira/shared";

const defaultSelection: AnalyticsExclusions = { mode: "default-admins" };
const storageKey = (accountId: string) => `moira:analytics-exclusions:${accountId}`;

export function restoreAnalyticsExclusions(accountId: string): AnalyticsExclusions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(accountId)) ?? "null");
    if (value && typeof value === "object" && "mode" in value) {
      if (value.mode === "default-admins") return defaultSelection;
      if (
        value.mode === "custom" &&
        "userIds" in value &&
        Array.isArray(value.userIds) &&
        value.userIds.length <= 100 &&
        value.userIds.every(
          (id) => typeof id === "string" && id.trim().length > 0 && id.trim().length <= 200,
        )
      ) {
        return {
          mode: "custom",
          userIds: [...new Set((value.userIds as string[]).map((id) => id.trim()))].sort(),
        };
      }
    }
  } catch {
    /* Unavailable storage and malformed old values use the default policy. */
  }
  return defaultSelection;
}

export function useAnalyticsExclusions(accountId: string | null) {
  const [state, setState] = useState<{
    accountId: string | null;
    value: AnalyticsExclusions;
    storageError: boolean;
  }>(() => ({
    accountId,
    value: accountId ? restoreAnalyticsExclusions(accountId) : defaultSelection,
    storageError: false,
  }));
  if (state.accountId !== accountId) {
    setState({
      accountId,
      value: accountId ? restoreAnalyticsExclusions(accountId) : defaultSelection,
      storageError: false,
    });
  }
  const value =
    state.accountId === accountId
      ? state.value
      : accountId
        ? restoreAnalyticsExclusions(accountId)
        : defaultSelection;
  const setValue = (selection: AnalyticsExclusions) => {
    if (!accountId) return;
    const next: AnalyticsExclusions =
      selection.mode === "custom"
        ? { mode: "custom", userIds: [...new Set(selection.userIds.map((id) => id.trim()))].sort() }
        : defaultSelection;
    let storageError = false;
    try {
      localStorage.setItem(storageKey(accountId), JSON.stringify(next));
    } catch {
      storageError = true;
    }
    setState({ accountId, value: next, storageError });
  };
  return { value, setValue, storageError: state.storageError };
}
