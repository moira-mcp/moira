import { z } from "zod";
import { PrivateState } from "./private-state.js";
import { LocalRefusal, type LocalPolicy } from "./policy.js";

const ledgerSchema = z
  .object({ leaseUntil: z.number(), spent: z.number().int().nonnegative() })
  .strict();

export interface NetworkAdmission {
  signal?: AbortSignal;
  /** Refresh the locally bound authority after waiting, before consuming credit. */
  refreshPolicy?: () => Promise<LocalPolicy>;
}

export const MAX_BROKER_CONNECTIONS = 128;

interface Reservation {
  maximumBytes: number;
  release: (used: number) => Promise<void>;
}
interface Waiter {
  policy: LocalPolicy;
  admission: NetworkAdmission;
  resolve: (reservation: Reservation) => void;
  reject: (error: unknown) => void;
  dispose: () => void;
  cancelled: boolean;
}

/** Reserve before opening a socket; an unclean shutdown loses credit rather than creating it. */
export class NetworkBudget {
  private tail: Promise<unknown> = Promise.resolve();
  private connections = 0;
  private readonly waiting: Waiter[] = [];
  private pumping = false;
  private wakePending = false;
  private closed = false;
  constructor(private readonly state: PrivateState) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** The broker fences admission before waiting for its final reservation releases. */
  async settle(): Promise<void> {
    let pending: Promise<unknown>;
    do {
      pending = this.tail;
      await pending;
    } while (pending !== this.tail);
  }

  /** Fence waiting consumers before the broker waits for its requests to finish. */
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
    void this.pump();
  }

  private async pump(): Promise<void> {
    this.wakePending = true;
    if (this.pumping) return;
    this.pumping = true;
    this.wakePending = false;
    try {
      while (this.waiting.length) {
        const waiter = this.waiting[0];
        try {
          const admitted = await this.serial(async () => {
            const policy = await (waiter.admission.refreshPolicy?.() ??
              Promise.resolve(waiter.policy));
            if (waiter.cancelled || this.closed) return true;
            if (!policy.enabled || policy.leaseUntil <= Date.now())
              throw new LocalRefusal("LOCAL_NETWORK_DENIED", "Local network lease is unavailable.");
            if (this.connections >= policy.limits.maxNetworkConnections) return false;
            const previous = await this.state.read("network-budget.json", ledgerSchema.parse);
            const current =
              previous?.leaseUntil === policy.leaseUntil
                ? previous
                : { leaseUntil: policy.leaseUntil, spent: 0 };
            const remaining = policy.limits.maxNetworkBytes - current.spent;
            if (remaining <= 0 && this.connections > 0) return false;
            if (remaining <= 0)
              throw new LocalRefusal(
                "LOCAL_NETWORK_BUDGET",
                "The locally approved network budget is exhausted.",
              );
            const maximumBytes = Math.min(128 * 1024 * 1024, remaining);
            current.spent += maximumBytes;
            await this.state.write("network-budget.json", current);
            if (waiter.cancelled || this.closed) {
              current.spent -= maximumBytes;
              await this.state.write("network-budget.json", current);
              return true;
            }
            this.connections++;
            this.remove(waiter);
            let released = false;
            waiter.resolve({
              maximumBytes,
              release: (used) =>
                this.serial(async () => {
                  if (released) return;
                  released = true;
                  this.connections--;
                  try {
                    const ledger = await this.state.read("network-budget.json", ledgerSchema.parse);
                    if (ledger?.leaseUntil === policy.leaseUntil) {
                      ledger.spent = Math.max(
                        0,
                        ledger.spent - Math.max(0, maximumBytes - Math.max(0, used)),
                      );
                      await this.state.write("network-budget.json", ledger);
                    }
                  } finally {
                    void this.pump();
                  }
                }),
            });
            return true;
          });
          if (!admitted) break;
        } catch (error) {
          this.cancel(waiter, error);
        }
      }
    } finally {
      this.pumping = false;
      if (this.wakePending) void this.pump();
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
            new LocalRefusal("LOCAL_NETWORK_CAPACITY", "Local network admission timed out."),
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
      void this.pump();
    });
  }
}
