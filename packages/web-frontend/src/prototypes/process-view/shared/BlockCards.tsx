/**
 * Baseline renderer: every block as a card in process order. Real data, real tokens — used as the
 * starting surface of each variant until that variant's own presentation replaces it.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatusChip, STATUS_STYLE } from "./status";
import { blockById, runStateOf, type ProcessProjection } from "../model";
import type { RunTrace } from "../trace";

export interface VariantProps {
  projection: ProcessProjection;
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string | null) => void;
  /** The recorded run behind `projection.run`, when one is selected. */
  trace?: RunTrace | null;
  /** Cursor along the trace (visit index); null means the whole run. */
  cursor?: number | null;
  onSetCursor?: (at: number | null) => void;
}

export function BlockCards({
  projection,
  selectedBlockId,
  onSelectBlock,
}: VariantProps): React.JSX.Element {
  const { t } = useTranslation();
  const blocks = blockById(projection);
  return (
    <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={projection.title}>
      {projection.blocks.map((block, index) => {
        const state = runStateOf(projection, block.id);
        const selected = selectedBlockId === block.id;
        return (
          <li key={block.id}>
            <Card
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-current={state.status === "active" ? "step" : undefined}
              onClick={() => onSelectBlock(selected ? null : block.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectBlock(selected ? null : block.id);
                }
              }}
              className={cn(
                "h-full cursor-pointer border-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                STATUS_STYLE[state.status].surface,
                selected && "ring-2 ring-ring",
              )}
              data-block-id={block.id}
              data-status={state.status}
            >
              <CardHeader className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base leading-6">
                    <span className="mr-2 tabular-nums text-muted-foreground">{index + 1}.</span>
                    {block.name}
                  </CardTitle>
                  <StatusChip state={state} />
                </div>
                <CardDescription className="text-sm leading-5 text-foreground/80">
                  {block.description}
                </CardDescription>
                {state.note && <p className="text-xs text-muted-foreground">{state.note}</p>}
              </CardHeader>
              <CardContent className="space-y-1.5 text-xs">
                {block.transitions.map((transition) => {
                  const target = blocks.get(transition.to);
                  return (
                    <p
                      key={`${transition.to}-${transition.label}`}
                      className={cn(
                        "flex items-start gap-1.5",
                        transition.cycle ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {transition.cycle ? (
                        <RotateCcw className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      ) : (
                        <ArrowRight className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                      )}
                      <span>
                        <span className="font-medium">{transition.label}</span>
                        <span className="text-muted-foreground">
                          {" "}
                          → {target?.name ?? transition.to}
                        </span>
                      </span>
                    </p>
                  );
                })}
                <p className="pt-1 text-[11px] text-muted-foreground">
                  {t("pages.processViewPrototype.nodeCount", { count: block.nodeIds.length })}
                </p>
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}
