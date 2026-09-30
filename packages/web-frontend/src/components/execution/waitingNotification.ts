/**
 * The line under a «waiting for you» notice: whether the person was told about the wait, how, and
 * how long ago. The run page and the overview's panel word it the same way.
 */

import type { TFunction } from "i18next";
import { formatDuration } from "../run/duration";

/** The latest notification about a wait, as the run page and the overview receive it. */
export interface WaitingMark {
  kind: "first" | "remind";
  state: string;
  sentAt: number | null;
  deliveryStatus: string | null;
  deliveredChannels: string[];
}

export function waitingNotificationText(
  mark: WaitingMark,
  t: TFunction,
  now: number = Date.now(),
): string {
  const key = "pages.executionInspector.waitingForUser.notification";
  if (mark.state === "superseded") return t(`${key}.superseded`);
  if (mark.state === "pending" || mark.sentAt === null) return t(`${key}.pending`);
  const ago = formatDuration(Math.max(0, now - mark.sentAt), t);
  switch (mark.deliveryStatus) {
    case "delivered":
    case "partial":
      return t(mark.kind === "remind" ? `${key}.reminded` : `${key}.sent`, {
        ago,
        channels: mark.deliveredChannels.join(", "),
      });
    case "no_configured_channels":
      return t(`${key}.noChannels`);
    default:
      return t(`${key}.failed`, { ago });
  }
}
