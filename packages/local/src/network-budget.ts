import { z } from "zod";
import { PrivateState } from "./private-state.js";
import { LocalRefusal, type LocalPolicy } from "./policy.js";

const ledgerSchema = z
  .object({ leaseUntil: z.number(), spent: z.number().int().nonnegative() })
  .strict();

/** Reserve before opening a socket; an unclean shutdown loses credit rather than creating it. */
export class NetworkBudget {
  private tail: Promise<unknown> = Promise.resolve();
  private connections = 0;
  constructor(private readonly state: PrivateState) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async reserve(
    policy: LocalPolicy,
  ): Promise<{ maximumBytes: number; release: (used: number) => Promise<void> }> {
    const maximumBytes = Math.min(128 * 1024 * 1024, policy.limits.maxNetworkBytes);
    await this.serial(async () => {
      if (this.connections >= policy.limits.maxNetworkConnections) {
        throw new LocalRefusal(
          "LOCAL_NETWORK_CAPACITY",
          "Local network connection capacity is busy.",
        );
      }
      const previous = await this.state.read("network-budget.json", ledgerSchema.parse);
      const current =
        previous?.leaseUntil === policy.leaseUntil
          ? previous
          : { leaseUntil: policy.leaseUntil, spent: 0 };
      if (current.spent + maximumBytes > policy.limits.maxNetworkBytes) {
        throw new LocalRefusal(
          "LOCAL_NETWORK_BUDGET",
          "The locally approved network budget is exhausted.",
        );
      }
      current.spent += maximumBytes;
      await this.state.write("network-budget.json", current);
      this.connections++;
    });
    let released = false;
    return {
      maximumBytes,
      release: (used) =>
        this.serial(async () => {
          if (released) return;
          released = true;
          this.connections--;
          const current = await this.state.read("network-budget.json", ledgerSchema.parse);
          if (current?.leaseUntil !== policy.leaseUntil) return;
          current.spent = Math.max(
            0,
            current.spent - Math.max(0, maximumBytes - Math.max(0, used)),
          );
          await this.state.write("network-budget.json", current);
        }),
    };
  }
}
