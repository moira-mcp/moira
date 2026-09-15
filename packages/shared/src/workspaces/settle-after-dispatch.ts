/**
 * A dispatched workspace operation is durable and resumable the moment the connector accepts it,
 * but most commands and file operations finish within a fraction of a second. Without this the
 * caller always pays a second round trip to collect a result that is already waiting.
 *
 * The window only inspects the remote outcome; it never dispatches, so an operation still cannot
 * run twice. An operation that has not finished when the window closes keeps its running envelope
 * and its identity, exactly as before.
 */
const SETTLE_DELAYS_MS = [150, 350, 750] as const;

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function settleAfterDispatch<Result>(
  delay: ((milliseconds: number) => Promise<void>) | undefined,
  inspect: () => Promise<Result | null>,
): Promise<Result | null> {
  const wait = delay ?? sleep;
  for (const milliseconds of SETTLE_DELAYS_MS) {
    await wait(milliseconds);
    try {
      const settled = await inspect();
      if (settled !== null) return settled;
    } catch {
      // The operation is durable; the caller keeps its resumable running envelope.
      return null;
    }
  }
  return null;
}
