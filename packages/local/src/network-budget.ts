import { LocalRefusal, type LocalPolicy } from "./policy.js";

export interface NetworkAdmission {
  signal?: AbortSignal;
  /** Revalidate VM-bound authority immediately before opening a connection. */
  refreshPolicy?: () => Promise<LocalPolicy>;
}

/** Bounds broker sockets and waiting memory, not downloaded data or development permissions. */
export const MAX_BROKER_CONNECTIONS = 128;
interface Reservation {
  release: () => Promise<void>;
}
interface Waiter {
  policy: LocalPolicy;
  admission: NetworkAdmission;
  resolve: (reservation: Reservation) => void;
  reject: (error: unknown) => void;
  dispose: () => void;
  cancelled: boolean;
}

/** Backpressure for the host broker. There is no traffic ledger or download byte ceiling. */
export class NetworkBudget {
  private connections = 0;
  private readonly waiting: Waiter[] = [];
  private pumping?: Promise<void>;
  private closed = false;

  constructor(private readonly capacity = MAX_BROKER_CONNECTIONS) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_BROKER_CONNECTIONS)
      throw new Error("Invalid broker socket capacity");
  }

  async settle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  closeAdmission(): void {
    this.closed = true;
    for (const waiter of [...this.waiting])
      this.cancel(waiter, new LocalRefusal("LOCAL_NETWORK_CANCELLED", "Network broker closed."));
  }

  private remove(waiter: Waiter): void {
    const index = this.waiting.indexOf(waiter);
    if (index !== -1) this.waiting.splice(index, 1);
    waiter.dispose();
  }

  private cancel(waiter: Waiter, error: unknown): void {
    if (waiter.cancelled) return;
    waiter.cancelled = true;
    this.remove(waiter);
    waiter.reject(error);
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = this.admit().finally(() => {
      this.pumping = undefined;
      if (!this.closed && this.waiting.length && this.connections < this.capacity) this.pump();
    });
  }

  private async admit(): Promise<void> {
    while (!this.closed && this.waiting.length && this.connections < this.capacity) {
      const waiter = this.waiting[0];
      try {
        const policy = await (waiter.admission.refreshPolicy?.() ?? Promise.resolve(waiter.policy));
        if (waiter.cancelled || this.closed) continue;
        if (!policy.enabled || policy.leaseUntil <= Date.now())
          throw new LocalRefusal(
            "LOCAL_NETWORK_DENIED",
            "Local network permission is unavailable.",
          );
        this.remove(waiter);
        this.connections++;
        let released = false;
        waiter.resolve({
          release: async () => {
            if (released) return;
            released = true;
            this.connections--;
            this.pump();
          },
        });
      } catch (error) {
        this.cancel(waiter, error);
      }
    }
  }

  async reserve(policy: LocalPolicy, admission: NetworkAdmission = {}): Promise<Reservation> {
    if (this.closed || admission.signal?.aborted)
      throw new LocalRefusal("LOCAL_NETWORK_CANCELLED", "Network admission was cancelled.");
    if (this.waiting.length >= MAX_BROKER_CONNECTIONS)
      throw new LocalRefusal("LOCAL_NETWORK_CAPACITY", "Local network admission queue is full.");
    return new Promise((resolve, reject) => {
      const abort = () =>
        this.cancel(
          waiter,
          new LocalRefusal("LOCAL_NETWORK_CANCELLED", "Network consumer closed."),
        );
      const timer = setTimeout(
        () =>
          this.cancel(
            waiter,
            new LocalRefusal("LOCAL_NETWORK_CAPACITY", "Network admission timed out."),
          ),
        Math.max(1, Math.min(120_000, policy.leaseUntil - Date.now())),
      );
      const waiter: Waiter = {
        policy,
        admission,
        resolve,
        reject,
        cancelled: false,
        dispose: () => {
          clearTimeout(timer);
          admission.signal?.removeEventListener("abort", abort);
        },
      };
      admission.signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiter);
      this.pump();
    });
  }
}
