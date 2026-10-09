/**
 * Better Auth React client for MCP Moira frontend
 */

import { createAuthClient } from "better-auth/react";
import { getGlobalBroadcastChannel } from "better-auth/client";
import {
  observeReadSession,
  getSessionAuthoritySignature,
  setReadSessionRevalidator,
  suspendReadSession,
  notifyReadSessionChange,
  setReadSessionNotifier,
  getReadOwner,
} from "../services/read-scope";

let changingCredentials = 0;
let observedSession: string | null = null;
const channel = getGlobalBroadcastChannel();
setReadSessionNotifier(() =>
  channel.post({
    event: "session",
    data: { trigger: "getSession" },
    clientId: Math.random().toString(36).slice(2),
  }),
);

// Subscribe before the provider session manager: another tab's session notification
// retires private reads immediately, before its queued authoritative check starts.
channel.subscribe(() => suspendReadSession());

function changesIdentity(request: { method: string; url: string | URL }): boolean {
  return (
    request.method.toUpperCase() !== "GET" &&
    !String(request.url).split("?")[0].endsWith("/get-session")
  );
}

export const authClient = createAuthClient({
  baseURL: "", // Same domain - better-auth auto-detects
  fetchOptions: {
    async customFetchImpl(input, init) {
      const changing = changesIdentity({ method: init?.method ?? "GET", url: String(input) });
      if (changing) {
        changingCredentials++;
        suspendReadSession();
        notifyReadSessionChange();
      }
      try {
        return await fetch(input, init);
      } finally {
        // Better Fetch's success/error hooks do not run when the network itself rejects.
        if (changing) {
          changingCredentials--;
          notifyReadSessionChange();
          void authClient.$store.atoms.session.get().refetch();
        }
      }
    },
  },
});

authClient.$store.atoms.session.listen((snapshot) => {
  if (changingCredentials || snapshot.isPending || snapshot.isRefetching) return;
  if (snapshot.error) {
    if (!snapshot.data && snapshot.error.status === 401) observeReadSession(null, null);
    else suspendReadSession();
    return;
  }
  observeReadSession(
    snapshot.data?.user.id ?? null,
    getSessionAuthoritySignature(snapshot.data?.session),
  );
  const next = snapshot.data
    ? JSON.stringify([snapshot.data.user.id, snapshot.data.session.id])
    : null;
  if (next !== observedSession) {
    observedSession = next;
    // Includes the first accepted observation after a full-page OAuth return. Ordinary
    // same-session renewal changes expiry fields, but does not notify peers or echo checks.
    notifyReadSessionChange();
  }
});
setReadSessionRevalidator(() => authClient.$store.atoms.session.get().refetch());

// Export hooks for components
export const { useSession, signIn, signUp, signOut } = authClient;

export type Session = typeof authClient.$Infer.Session;

/** A canceled refetch promise can finish before the replacement session request settles. */
export function waitForSessionSettlement(signal?: AbortSignal) {
  const atom = authClient.$store.atoms.session;
  return new Promise<ReturnType<typeof atom.get> | null>((resolve) => {
    let unsubscribe = () => {};
    const finish = (snapshot: ReturnType<typeof atom.get> | null) => {
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      resolve(snapshot);
    };
    const abort = () => finish(null);
    const settled = (snapshot: ReturnType<typeof atom.get>) => {
      if (!snapshot.isPending && !snapshot.isRefetching) finish(snapshot);
    };
    signal?.addEventListener("abort", abort, { once: true });
    unsubscribe = atom.listen(settled);
    if (signal?.aborted) abort();
    else settled(atom.get());
  });
}

/** Revoke the observed session, never whichever cookie became current in another tab.
 * The boolean permits caller-owned completion; it does not claim delivery on a failed request.
 */
export async function revokeObservedSession(
  original: Session["session"] | null | undefined,
): Promise<boolean> {
  const owner = getReadOwner();
  const signature = getSessionAuthoritySignature(original);
  let replaced = false;
  const atom = authClient.$store.atoms.session;
  const stop = atom.listen((snapshot) => {
    if (
      snapshot.data &&
      (snapshot.data.user.id !== original?.userId ||
        getSessionAuthoritySignature(snapshot.data.session) !== signature)
    )
      replaced = true;
  });
  try {
    try {
      if (original?.token) await authClient.revokeSession({ token: original.token });
    } catch {
      // Cleanup refusal does not transfer ownership. The authoritative check below
      // still decides whether the original caller may finish its login fallback.
    } finally {
      await atom.get().refetch();
      await waitForSessionSettlement();
    }
    const current = atom.get();
    return !replaced && !current.error && (!current.data || owner === getReadOwner());
  } catch {
    // A failed cleanup/check cannot authorize a later caller completion.
    return false;
  } finally {
    stop();
  }
}
