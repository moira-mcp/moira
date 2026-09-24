/**
 * Which of several overlapping requests is the latest. A page that refetches when its query
 * changes — a filter, a page, the page size settling after the items are measured — can have two
 * requests in flight, and the older one may answer last. `beginRequest()` marks a new request and
 * returns `isCurrent()`, which stays true only until the next one begins; a response or an error
 * whose request is no longer current is dropped instead of overwriting the newer result.
 */

import { useCallback, useRef } from "react";

export function useLatestRequest(): () => () => boolean {
  const latest = useRef(0);
  return useCallback(() => {
    const request = ++latest.current;
    return () => request === latest.current;
  }, []);
}
