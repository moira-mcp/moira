/**
 * One line of route facts for a run: how many visits the route recorded, how many of them were
 * working steps (not routing nodes), how many times the run looped back, and how many values were
 * adjusted by hand. What the retired route view showed in its summary, now in the block panel.
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionRouteEntry } from "@mcp-moira/workflow-engine/progress-visual";
import type { WorkflowGraph } from "../../types/workflow-types";
import { ROUTING_NODE_TYPES, type RunBlock } from "./model";

export function routeSummary(
  route: readonly ExecutionRouteEntry[],
  workflow: WorkflowGraph | undefined,
  blocks: readonly RunBlock[],
): { visits: number; working: number; loops: number; adjustments: number } {
  const types = new Map((workflow?.nodes ?? []).map((n) => [n.id, n.type]));
  const indexOf = new Map(blocks.map((b) => [b.id, b.index]));
  let working = 0;
  let loops = 0;
  let adjustments = 0;
  let previousBlock: number | null = null;
  for (const visit of route) {
    if (!ROUTING_NODE_TYPES.has(types.get(visit.nodeId) ?? "")) working += 1;
    if (visit.adjusted) adjustments += 1;
    const index = visit.blockId ? (indexOf.get(visit.blockId) ?? null) : null;
    if (visit.loop || (index !== null && previousBlock !== null && index < previousBlock)) {
      loops += 1;
    }
    if (index !== null) previousBlock = index;
  }
  return { visits: route.length, working, loops, adjustments };
}

export function RouteSummary({
  route,
  workflow,
  blocks,
}: {
  route: readonly ExecutionRouteEntry[];
  workflow?: WorkflowGraph;
  blocks: RunBlock[];
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const summary = useMemo(() => routeSummary(route, workflow, blocks), [route, workflow, blocks]);
  if (route.length === 0) return null;
  const parts: Array<[string, number]> = [
    [t("pages.runPage.route.stat.visits"), summary.visits],
    [t("pages.runPage.route.stat.working"), summary.working],
    [t("pages.runPage.route.stat.loops"), summary.loops],
    [t("pages.runPage.route.stat.adjustments"), summary.adjustments],
  ];
  return (
    <p
      className="mx-4 mt-3 rounded-lg border bg-card px-3 py-2 text-xs leading-5 tabular-nums text-muted-foreground"
      data-testid="route-summary"
      data-loops={summary.loops}
      data-adjustments={summary.adjustments}
    >
      {parts.map(([label, value]) => `${value} ${label}`).join(" · ")}
    </p>
  );
}
