/**
 * The route cursor control: step back and forth along the recorded route or drag to a visit. The
 * cursor lives in the URL (`at`), so a position can be linked to; every mode shows the run as it
 * stood at the cursor, and the variables panel shows the values written up to it.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionRouteEntry } from "@mcp-moira/workflow-engine/progress-visual";
import { GuidanceHint } from "./Guidance";

export function RunCursor({
  route,
  cursor,
  onSetCursor,
}: {
  /** The whole recorded route (not the cut one), so the range spans every visit. */
  route: readonly ExecutionRouteEntry[];
  cursor: number | null;
  onSetCursor: (at: number | null) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (route.length === 0) return null;
  const last = route[route.length - 1].seq;
  const position = cursor ?? last;
  const node = route.find((v) => v.seq === position)?.nodeId ?? "";
  return (
    <div
      className="flex min-w-0 flex-nowrap items-center gap-1.5 px-1 py-0.5"
      data-testid="run-cursor"
    >
      <button
        type="button"
        className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
        disabled={position <= 0}
        onClick={() => onSetCursor(Math.max(0, position - 1))}
        aria-label={t("pages.runPage.cursor.prev")}
        data-testid="cursor-prev"
      >
        ‹
      </button>
      <input
        type="range"
        min={0}
        max={last}
        value={position}
        onChange={(event) => onSetCursor(Number(event.target.value))}
        className="h-1.5 w-28 cursor-pointer accent-primary xl:w-40"
        aria-label={t("pages.runPage.cursor.scrub")}
        data-testid="cursor-range"
      />
      <button
        type="button"
        className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
        disabled={cursor === null}
        onClick={() => onSetCursor(position + 1 >= last ? null : position + 1)}
        aria-label={t("pages.runPage.cursor.next")}
        data-testid="cursor-next"
      >
        ›
      </button>
      <span
        className="hidden whitespace-nowrap text-xs tabular-nums text-muted-foreground 2xl:inline"
        data-testid="cursor-position"
      >
        {cursor === null
          ? t("pages.runPage.cursor.wholeRun", { count: route.length })
          : t("pages.runPage.cursor.position", { at: cursor, total: last, node })}
      </span>
      {cursor !== null && (
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={() => onSetCursor(null)}
          data-testid="cursor-clear"
        >
          {t("pages.runPage.cursor.clear")}
        </button>
      )}
      <GuidanceHint label={t("pages.runPage.cursor.hintLabel")}>
        {t("pages.runPage.cursor.hint")}
      </GuidanceHint>
    </div>
  );
}
