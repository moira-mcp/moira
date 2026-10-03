import { getReadGeneration } from "./read-scope";

/** The caller must revalidate under its original authority before publishing a result. */
export class ReadRetiredError extends Error {
  constructor() {
    super("Read was retired; refresh to retry");
  }
}

interface Representation<T> {
  value: T;
  etag: string;
  retainedAt: number;
}

/** Retention limits memory; every read still validates the current source over HTTP. */
export class ConditionalReadStore<T> {
  private successes = new Map<string, Representation<T>>();
  private flights = new Map<string, Promise<T>>();
  private generation = getReadGeneration();

  constructor(
    private readonly maxEntries = 128,
    private readonly retentionMs = 5 * 60_000,
    private readonly maxRepresentationBytes = 1_000_000,
  ) {}

  clear(): void {
    this.successes.clear();
    this.flights.clear();
  }

  read(
    key: string,
    fetch: (etag?: string) => Promise<{ value: T; etag?: string; unchanged?: boolean }>,
    conditional: boolean,
  ): Promise<T> {
    if (this.generation !== getReadGeneration()) {
      this.clear();
      this.generation = getReadGeneration();
    }
    const existing = this.flights.get(key);
    if (existing) return existing;
    const generation = getReadGeneration();
    const saved = this.successes.get(key);
    const retained = saved && Date.now() - saved.retainedAt < this.retentionMs ? saved : undefined;
    if (!retained) this.successes.delete(key);
    const flight = Promise.resolve()
      .then(() => {
        if (generation !== getReadGeneration()) throw new ReadRetiredError();
        return fetch(conditional ? retained?.etag : undefined);
      })
      .then((result) => {
        if (generation !== getReadGeneration()) throw new ReadRetiredError();
        if (result.unchanged && !retained) throw new Error("304 has no matching representation");
        const value = result.unchanged ? retained!.value : result.value;
        const etag = result.etag ?? (result.unchanged ? retained?.etag : undefined);
        if (
          conditional &&
          etag &&
          JSON.stringify(value).length * 2 <= this.maxRepresentationBytes
        ) {
          this.successes.delete(key);
          this.successes.set(key, { value, etag, retainedAt: Date.now() });
          while (this.successes.size > this.maxEntries) {
            this.successes.delete(this.successes.keys().next().value!);
          }
        }
        return value;
      })
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    if (this.flights.size < this.maxEntries) this.flights.set(key, flight);
    return flight;
  }
}
