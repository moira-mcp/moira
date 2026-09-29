/**
 * The duration form of a human gate's `remindAfter`.
 *
 * It lives here rather than in the engine because both sides read it: the engine's sender queues a
 * reminder when it sends a gate's first notification, and the notification queue — inside the
 * writer's transaction, in this package — queues the reminder of a gate whose flow sends its own
 * first message (`notify: "off"`).
 */

/** Matches the duration form `remindAfter` accepts: a positive integer and m, h or d. */
export const HUMAN_GATE_DURATION_PATTERN = /^[1-9][0-9]{0,4}[mhd]$/;

/** A `remindAfter` value in milliseconds, or null when absent or not in the accepted form. */
export function humanGateDurationMs(value: string | undefined): number | null {
  if (value === undefined || !HUMAN_GATE_DURATION_PATTERN.test(value)) return null;
  const amount = Number(value.slice(0, -1));
  const unit = value.slice(-1);
  const minute = 60_000;
  return amount * (unit === "m" ? minute : unit === "h" ? 60 * minute : 24 * 60 * minute);
}
