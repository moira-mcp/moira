/**
 * A request the interface makes to one of its own surfaces — focus this step, highlight that
 * variable, unfold this section, mark that card as arrived — is a payload plus a token, so that
 * asking for the same thing twice is two requests and the effect that answers runs again. This
 * hook keeps the state and mints the token; `send(null)` withdraws the request.
 */

import { useCallback, useState } from "react";

export type Request<T> = T & { token: number };

export function useRequest<T extends object>(): [Request<T> | null, (payload: T | null) => void] {
  const [request, setRequest] = useState<Request<T> | null>(null);
  const send = useCallback((payload: T | null) => {
    setRequest((previous) =>
      payload === null ? null : { ...payload, token: (previous?.token ?? 0) + 1 },
    );
  }, []);
  return [request, send];
}
