/**
 * A dispatched codespace operation is durable and resumable the moment the connector accepts it,
 * but most commands and file operations finish within a fraction of a second. Without this the
 * caller always pays a second round trip to collect a result that is already waiting.
 *
 * The window only inspects the remote outcome; it never dispatches, so an operation still cannot
 * run twice. An operation that has not finished when the window closes keeps its running envelope
 * and its identity, exactly as before.
 */
import { CodespaceResourceError } from "./resource-types.js";

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

/** Explicit caller waiting uses the accepted operation deadline, not the short HTTP settle window. */
export async function waitForAcceptedCodespaceResult<Result>(input: {
  deadlineAt: number;
  now: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  inspect: () => Promise<Result | null>;
}): Promise<Result> {
  for (;;) {
    const result = await input.inspect();
    if (result !== null) return result;
    const remaining = input.deadlineAt - input.now();
    if (remaining <= 0)
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "The accepted operation deadline ended without a confirmed result",
      );
    await (input.delay ?? sleep)(Math.min(1000, remaining));
  }
}
