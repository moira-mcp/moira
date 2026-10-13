import { createHash } from "node:crypto";
import { z } from "zod";
import { PrivateState } from "./private-state.js";
import { LocalRefusal } from "./policy.js";
import { LOCAL_RESULT_SETTLEMENT_RETENTION_MS } from "../../shared/src/codespaces/local-protocol.js";

const receipt = z
  .object({
    id: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().nonnegative(),
    state: z.enum(["accepted", "complete", "collected"]),
    settled: z.boolean().optional(),
  })
  .strict();
const receipts = z.array(receipt);

/** A lost answer is not permission to repeat a side effect. Inspection uses a different request. */
export class RequestJournal {
  private pending = new Map<string, Promise<unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly state: PrivateState,
    private readonly now = Date.now,
  ) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Collection authority is distinct from admission: this path can only read an exact receipt. */
  async retained(id: string, expiresAt: number, input: unknown): Promise<unknown | undefined> {
    z.string().uuid().parse(id);
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.serial(async () => {
      const entries = (await this.state.read("lifecycle-receipts.json", receipts.parse)) ?? [];
      const entry = entries.find((item) => item.id === id);
      if (
        !entry ||
        entry.state !== "complete" ||
        entry.expiresAt + LOCAL_RESULT_SETTLEMENT_RETENTION_MS <= this.now()
      )
        return undefined;
      if (entry.digest !== digest || entry.expiresAt !== expiresAt)
        throw new LocalRefusal(
          "LOCAL_REPLAY_CONFLICT",
          "The retained receipt cannot change its accepted request.",
        );
      return (await this.state.read(`lifecycle-result-${id}.json`, (value) => value)) ?? undefined;
    });
  }

  /** Inspect a retained admission without redispatching or accepting a completed request. */
  async isAccepted(
    id: string,
    expiresAt: number,
    input: unknown,
    includeComplete = false,
  ): Promise<boolean> {
    const entries = (await this.state.read("lifecycle-receipts.json", receipts.parse)) ?? [];
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return entries.some(
      (entry) =>
        entry.id === id &&
        (entry.state === "accepted" || (includeComplete && entry.state === "complete")) &&
        entry.expiresAt === expiresAt &&
        expiresAt > this.now() &&
        entry.digest === digest,
    );
  }

  async run(
    id: string,
    expiresAt: number,
    input: unknown,
    action: () => Promise<unknown>,
  ): Promise<unknown> {
    z.string().uuid().parse(id);
    const encoded = JSON.stringify(input);
    if (typeof encoded !== "string") {
      throw new LocalRefusal("LOCAL_REQUEST_TOO_LARGE", "Local request is too large.");
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
      throw new LocalRefusal(
        "LOCAL_REQUEST_EXPIRED",
        "Local request is expired or outside its time window.",
      );
    }
    const digest = createHash("sha256").update(encoded).digest("hex");
    let work: Promise<unknown> | undefined;
    let cached = false;
    await this.serial(async () => {
      const entries = await this.clean();
      const existing = entries.find((entry) => entry.id === id);
      if (existing) {
        if (existing.digest !== digest || existing.expiresAt !== expiresAt) {
          throw new LocalRefusal(
            "LOCAL_REPLAY_CONFLICT",
            "A request identity cannot change its contents.",
          );
        }
        if (existing.state === "complete") {
          cached = true;
          return;
        }
        if (existing.state === "collected")
          throw new LocalRefusal(
            "LOCAL_RESULT_EXPIRED",
            "The result was acknowledged and removed.",
          );
        work = this.pending.get(id);
        if (work) return;
        throw new LocalRefusal(
          "LOCAL_OUTCOME_UNKNOWN",
          "The lifecycle request may have run; inspect its resource instead of repeating it.",
        );
      }
      entries.push({ id, digest, expiresAt, state: "accepted" });
      await this.state.write("lifecycle-receipts.json", entries);
      // Defer the side effect until the index mutation has left the serialization boundary.
      work = Promise.resolve()
        .then(action)
        .then(async (result) => {
          const bytes = JSON.stringify(result);
          if (typeof bytes !== "string") {
            throw new LocalRefusal("LOCAL_OUTPUT_LIMIT", "Local result is too large.");
          }
          await this.serial(async () => {
            await this.state.write(`lifecycle-result-${id}.json`, result);
            const current =
              (await this.state.read("lifecycle-receipts.json", receipts.parse)) ?? [];
            const entry = current.find((item) => item.id === id);
            if (!entry)
              throw new LocalRefusal("LOCAL_OUTCOME_UNKNOWN", "Request journal entry was lost.");
            entry.state = "complete";
            await this.state.write("lifecycle-receipts.json", current);
          });
          return result;
        })
        .finally(() => this.pending.delete(id));
      this.pending.set(id, work);
      void work.catch(() => undefined);
    });
    if (cached) {
      const result = await this.state.read(`lifecycle-result-${id}.json`, (value) => value);
      if (result === null)
        throw new LocalRefusal("LOCAL_RESULT_EXPIRED", "Local request result expired.");
      return result;
    }
    return work;
  }

  async acknowledge(id: string, retainLiveReplay = false): Promise<void> {
    z.string().uuid().parse(id);
    await this.serial(async () => {
      const entries = (await this.state.read("lifecycle-receipts.json", receipts.parse)) ?? [];
      const entry = entries.find((item) => item.id === id);
      if (entry?.state === "complete") {
        if (retainLiveReplay && entry.expiresAt > this.now()) {
          entry.settled = true;
          await this.state.write("lifecycle-receipts.json", entries);
          return;
        }
        entry.state = "collected";
        await this.state.write("lifecycle-receipts.json", entries);
        await this.state.remove(`lifecycle-result-${id}.json`);
      }
    });
  }

  private async clean() {
    const entries = (await this.state.read("lifecycle-receipts.json", receipts.parse)) ?? [];
    const keep = entries.filter(
      (entry) =>
        entry.expiresAt +
          (entry.state === "collected" || entry.settled
            ? 0
            : LOCAL_RESULT_SETTLEMENT_RETENTION_MS) >
          this.now() || this.pending.has(entry.id),
    );
    await this.state.write("lifecycle-receipts.json", keep);
    for (const key of await this.state.keys("lifecycle-result-")) {
      if (
        !keep.some(
          (entry) => key === `lifecycle-result-${entry.id}.json` && entry.state !== "collected",
        )
      )
        await this.state.remove(key);
    }
    return keep;
  }

  async expire(): Promise<void> {
    await this.serial(() => this.clean());
  }
}
