/**
 * A check result is announced once: the polite live region hears a result when it differs from the
 * last one heard, and nothing while the result stays the same, however often the page re-renders.
 */

import { useEffect, useRef } from "react";

export function useResultAnnouncement(
  key: string,
  message: string | null,
  announce: (message: string) => void,
): void {
  const heard = useRef<string | null>(null);
  useEffect(() => {
    if (key === heard.current) return;
    heard.current = key;
    if (message) announce(message);
  }, [key, message, announce]);
}
