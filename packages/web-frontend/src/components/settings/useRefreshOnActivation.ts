import { useEffect, useRef } from "react";

/** A retained settings surface reads source again when the reader returns to it. */
export function useRefreshOnActivation(
  active: boolean,
  refresh: () => void | Promise<unknown>,
): void {
  const wasActive = useRef(active);
  useEffect(() => {
    const returning = active && !wasActive.current;
    wasActive.current = active;
    if (returning) void refresh();
  }, [active, refresh]);
}
