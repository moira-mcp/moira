/** Private read identity. Credentials never leave this module or become a URL/header. */
let account: string | null = null;
let credential: string | null = null;
let backend = "";
const capabilities = new Map<string, string>();
let suspended = false;
let version = 0;
let generation = 0;
let credentialVersion = 0;
const listeners = new Set<() => void>();
let revalidateSession: (() => Promise<unknown>) | undefined;
let notifySession: (() => void) | undefined;

export function setReadSessionRevalidator(revalidate: () => Promise<unknown>): void {
  revalidateSession = revalidate;
}

export function setReadSessionNotifier(notify: () => void): void {
  notifySession = notify;
}

/** Ask other provider instances to recheck after a local credential effect. */
export function notifyReadSessionChange(): void {
  notifySession?.();
}

export function revalidateReadSession(): void {
  suspendReadSession();
  void revalidateSession?.();
}

export const subscribeReadScope = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getReadScopeVersion = (): number => version;
export const getReadGeneration = (): number => generation;
export const getReadOwner = (): string => JSON.stringify([backend, account]);
/** Authentication transitions, independent of capability observations made by an admission read. */
export const getReadCredentialVersion = (): number => credentialVersion;
export const isReadSessionSuspended = (): boolean => suspended;
export const isPrivateReadSuspended = (): boolean => isReadSessionSuspended() && account !== null;
export const getReadIdentity = (): string | null =>
  account && credential && !suspended
    ? JSON.stringify([backend, account, version, [...capabilities]])
    : null;

export function retireReads(): void {
  generation++;
}

function changed(): void {
  version++;
  retireReads();
  listeners.forEach((listener) => listener());
}

/** Public provider fields identify the accepted session observation without retaining its token. */
export function getSessionAuthoritySignature(
  session:
    | { id: string; expiresAt: Date | string | number; updatedAt: Date | string | number }
    | null
    | undefined,
): string | null {
  if (!session?.id) return null;
  const timestamp = (value: Date | string | number): number | null => {
    const millis =
      value instanceof Date
        ? value.getTime()
        : typeof value === "number"
          ? value
          : Date.parse(value);
    return Number.isFinite(millis) ? millis : null;
  };
  return JSON.stringify([session.id, timestamp(session.expiresAt), timestamp(session.updatedAt)]);
}

export function observeReadSession(userId: string | null, sessionObservation: string | null): void {
  if (account === userId && credential === sessionObservation && !suspended) return;
  credentialVersion++;
  account = userId;
  credential = sessionObservation;
  suspended = false;
  changed();
}

/** Retire immediately, before Better Auth's delayed session signal can run. */
export function suspendReadSession(): void {
  suspended = true;
  credentialVersion++;
  changed();
}

export function observeReadBackend(value: string): void {
  const normalized = value.replace(/\/$/, "");
  if (backend === normalized) return;
  credentialVersion++;
  backend = normalized;
  changed();
}

export function observeReadCapabilities(value: string, source = "features"): void {
  if (capabilities.get(source) === value) return;
  capabilities.set(source, value);
  changed();
}

/** Raw product effects retain their existing Response/error contracts, including partial writes. */
export async function runReadInvalidatingEffect<T>(effect: () => Promise<T>): Promise<T> {
  retireReads();
  try {
    return await effect();
  } finally {
    retireReads();
  }
}
