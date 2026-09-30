/**
 * How the overview is kept current, said in a word and, in the hint, in a sentence: live, being
 * reconnected, or checked every 15 seconds. It is the page's only live region.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Hint } from "../diagram/Hint";
import type { LiveSnapshot } from "./liveConnection";
import { agoText } from "./format";

export function ConnectionIndicator({
  snapshot,
  now,
  guide,
}: {
  snapshot: LiveSnapshot;
  now: number;
  guide?: { "data-guide": string };
}): React.JSX.Element {
  const { t } = useTranslation();
  const { state, lastEventAt } = snapshot;
  const hint =
    state === "live"
      ? lastEventAt !== null
        ? t("pages.overview.live.hint.liveLast", { ago: agoText(now - lastEventAt, t) })
        : t("pages.overview.live.hint.live")
      : t(`pages.overview.live.hint.${state}`);
  return (
    <Hint content={hint} side="bottom" align="start">
      <span
        className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground"
        role="status"
        aria-live="polite"
        tabIndex={0}
        data-testid="overview-connection"
        data-state={state}
        {...guide}
      >
        <span
          className={cn(
            "h-2 w-2 flex-none rounded-full",
            state === "live" && "animate-pulse bg-success",
            (state === "reconnecting" || state === "connecting") && "bg-warning",
            state === "polling" && "bg-muted-foreground",
          )}
          aria-hidden="true"
        />
        {t(`pages.overview.live.${state}`)}
      </span>
    </Hint>
  );
}
