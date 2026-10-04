import { createHash } from "node:crypto";
import { z } from "zod";
import { PrivateState } from "./private-state.js";
import { LocalRefusal, MAX_MESSAGE_BYTES } from "./policy.js";

const receipt = z.object({
  id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().nonnegative(),
  state: z.enum(["accepted", "complete", "collected"]),
  reservedBytes: z.number().int().min(0).max(MAX_MESSAGE_BYTES),
}).strict();
const receipts = z.array(receipt).max(1024);
const SPOOL_LIMIT = 64 * 1024 * 1024;

/** A lost answer is not permission to repeat a side effect. Inspection uses a different request. */
export class RequestJournal {
  private pending = new Map<string, Promise<unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly state: PrivateState, private readonly now = Date.now) {}

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async run(id: string, expiresAt: number, input: unknown, action: () => Promise<unknown>): Promise<unknown> {
    z.string().uuid().parse(id);
    const encoded = JSON.stringify(input);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) {
      throw new LocalRefusal("LOCAL_REQUEST_TOO_LARGE", "Local request is too large.");
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 15 * 60_000) {
      throw new LocalRefusal("LOCAL_REQUEST_EXPIRED", "Local request is expired or outside its time window.");
    }
    const digest = createHash("sha256").update(encoded).digest("hex");
    let work: Promise<unknown> | undefined;
    let cached = false;
    await this.serial(async () => {
      const entries = await this.clean();
      const existing = entries.find((entry) => entry.id === id);
      if (existing) {
        if (existing.digest !== digest || existing.expiresAt !== expiresAt) {
          throw new LocalRefusal("LOCAL_REPLAY_CONFLICT", "A request identity cannot change its contents.");
        }
        if (existing.state === "complete") { cached = true; return; }
        if (existing.state === "collected") throw new LocalRefusal("LOCAL_RESULT_EXPIRED", "The result was acknowledged and removed.");
        work = this.pending.get(id);
        if (work) return;
        throw new LocalRefusal("LOCAL_OUTCOME_UNKNOWN", "The request may have run; inspect its resource or operation instead of repeating it.");
      }
      if (entries.length >= 1024 || entries.reduce((sum, item) => sum + item.reservedBytes, 0) + MAX_MESSAGE_BYTES > SPOOL_LIMIT) {
        throw new LocalRefusal("LOCAL_REQUEST_CAPACITY", "Local request capacity is busy; acknowledge or expire retained results.");
      }
      entries.push({ id, digest, expiresAt, state: "accepted", reservedBytes: MAX_MESSAGE_BYTES });
      await this.state.write("requests.json", entries);
      // Defer the side effect until the index mutation has left the serialization boundary.
      work = Promise.resolve().then(action).then(async (result) => {
        const bytes = JSON.stringify(result);
        if (typeof bytes !== "string" || Buffer.byteLength(bytes) > MAX_MESSAGE_BYTES) {
          throw new LocalRefusal("LOCAL_OUTPUT_LIMIT", "Local result is too large.");
        }
        await this.serial(async () => {
          await this.state.write(`result-${id}.json`, result);
          const current = await this.state.read("requests.json", receipts.parse) ?? [];
          const entry = current.find((item) => item.id === id);
          if (!entry) throw new LocalRefusal("LOCAL_OUTCOME_UNKNOWN", "Request journal entry was lost.");
          entry.state = "complete";
          entry.reservedBytes = Buffer.byteLength(bytes);
          await this.state.write("requests.json", current);
        });
        return result;
      }).finally(() => this.pending.delete(id));
      this.pending.set(id, work);
      void work.catch(() => undefined);
    });
    if (cached) {
      const result = await this.state.read(`result-${id}.json`, (value) => value);
      if (result === null) throw new LocalRefusal("LOCAL_RESULT_EXPIRED", "Local request result expired.");
      return result;
    }
    return work;
  }

  async acknowledge(id: string): Promise<void> {
    z.string().uuid().parse(id);
    await this.serial(async () => {
      const entries = await this.state.read("requests.json", receipts.parse) ?? [];
      const entry = entries.find((item) => item.id === id);
      if (entry?.state === "complete") {
        entry.state = "collected";
        entry.reservedBytes = 0;
        await this.state.write("requests.json", entries);
        await this.state.remove(`result-${id}.json`);
      }
    });
  }

  private async clean() {
    const entries = await this.state.read("requests.json", receipts.parse) ?? [];
    const keep = entries.filter((entry) => entry.expiresAt > this.now() || this.pending.has(entry.id));
    await this.state.write("requests.json", keep);
    for (const key of await this.state.keys("result-")) {
      if (!keep.some((entry) => key === `result-${entry.id}.json` && entry.state !== "collected")) await this.state.remove(key);
    }
    return keep;
  }

  async expire(): Promise<void> { await this.serial(() => this.clean()); }
}
