import { LocalRefusal, type LocalPolicy } from "./policy.js";

export interface NetworkAdmission {
  signal?: AbortSignal;
  /** Revalidate VM-bound authority immediately before opening a connection. */
  refreshPolicy?: () => Promise<LocalPolicy>;
}
interface Reservation {
  release: () => Promise<void>;
}

/** Broker admission checks authority; socket and stream backpressure belong to the OS. */
export class NetworkBudget {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<Reservation>>();

  closeAdmission(): void {
    this.controller.abort();
  }
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  reserve(policy: LocalPolicy, admission: NetworkAdmission = {}): Promise<Reservation> {
    const signal = admission.signal
      ? AbortSignal.any([admission.signal, this.controller.signal])
      : this.controller.signal;
    const cancelled = () =>
      new LocalRefusal("LOCAL_NETWORK_CANCELLED", "Network admission was cancelled.");
    if (signal.aborted) return Promise.reject(cancelled());
    const work = new Promise<Reservation>((resolve, reject) => {
      const abort = () => reject(cancelled());
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => admission.refreshPolicy?.() ?? policy)
        .then((fresh) => {
          if (signal.aborted) throw cancelled();
          if (!fresh.enabled)
            throw new LocalRefusal(
              "LOCAL_NETWORK_DENIED",
              "Local network permission is unavailable.",
            );
          resolve({ release: async () => {} });
        }, reject)
        .catch(reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => undefined);
    return work;
  }
}
