/**
 * The list a block is bound to, as the run resolved it: how many of its items are done, the items
 * themselves with the one in progress marked and the time the block's passes spent on each, and —
 * when the binding names counters but no items array — the counters alone. Nothing here is
 * inferred: the items, the counters and the current position all come from the projection.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { useRef } from "react";
import { ListMarker } from "../diagram/ListMarker";
import { useHighlightTarget, type HighlightRequest } from "../diagram/useHighlightTarget";
import { cn } from "@/lib/utils";
import { formatDuration } from "./duration";
import { listProgressLabel, type RunBlock } from "./model";

export function BlockListCard({
  block,
  className,
  highlight = null,
}: {
  block: RunBlock;
  className?: string;
  /** The item (by index) to scroll to and mark. */
  highlight?: HighlightRequest | null;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const list = block.list ?? null;
  const ref = useRef<HTMLElement>(null);
  useHighlightTarget(ref, highlight, (name) => `[data-index="${name}"]`);
  if (!list) return null;
  const [done, total] = (listProgressLabel(list) ?? "—/—").split("/");
  return (
    <section
      ref={ref}
      className={cn("space-y-1", className)}
      data-testid="block-list"
      data-block-id={block.id}
      aria-label={t("pages.runPage.list.title")}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("pages.runPage.list.title")}
        </p>
        <p className="text-sm font-semibold tabular-nums" data-testid="block-list-progress">
          {t("pages.runPage.list.progress", { done, total })}
        </p>
      </div>
      {list.items === null ? (
        <p className="text-sm text-muted-foreground" data-testid="block-list-counters-only">
          {list.currentTitle
            ? t("pages.runPage.list.countersOnlyCurrent", { title: list.currentTitle })
            : t("pages.runPage.list.countersOnly")}
        </p>
      ) : (
        <ol className="space-y-0.5 text-sm">
          {list.items.map((item) => {
            return (
              <li
                key={item.index}
                className={cn(
                  "flex items-baseline gap-2 rounded-md px-1.5 py-0.5",
                  item.current && "bg-primary/5 font-medium",
                  !item.current && item.done && "text-muted-foreground",
                )}
                data-testid="block-list-item"
                data-index={item.index}
                data-current={item.current ? "true" : "false"}
                data-done={item.done ? "true" : "false"}
              >
                <ListMarker done={item.done} current={item.current} className="self-center" />
                <span className="min-w-0 flex-1 break-words">{item.title}</span>
                {item.current && (
                  <span className="text-[11px] text-primary">
                    {t("pages.runPage.list.current")}
                  </span>
                )}
                <span
                  className="shrink-0 tabular-nums text-muted-foreground"
                  data-testid="block-list-item-duration"
                >
                  {formatDuration(item.durationMs, t)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
