/**
 * The overview's cards, laid out. A run with child runs is a group on a shared backdrop: its card
 * and its children's cards, a child with children of its own as a nested group inside it — "group
 * in group", no arrows; the relation is the backdrop, the group heading and the child's subtitle.
 * From the third level a nested group starts folded. Two layouts: the grid packs single tasks and
 * gives a group the full width; lanes put every task on its own horizontal strip.
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OverviewRun } from "../../services/api-client";
import { boardNode, type BoardNode, type OverviewLayout } from "./model";
import { OverviewCard } from "./OverviewCard";

interface BoardProps {
  runs: OverviewRun[];
  layout: OverviewLayout;
  now: number;
  onOpen: (executionId: string) => void;
}

function GroupView({
  node,
  parentTitle,
  layout,
  now,
  onOpen,
  unfolded,
  toggle,
}: {
  node: Extract<BoardNode, { kind: "group" }>;
  parentTitle: string | null;
  layout: OverviewLayout;
  now: number;
  onOpen: (id: string) => void;
  unfolded: ReadonlySet<string>;
  toggle: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { run, depth } = node;
  const folded = node.foldable && !unfolded.has(run.executionId);
  const cardClass = layout === "lanes" ? "w-[300px] flex-none" : "w-full sm:w-[300px] sm:flex-none";
  const children = folded
    ? null
    : node.children.map((child) => (
        <NodeView
          key={child.run.executionId}
          node={child}
          parentTitle={run.title}
          layout={layout}
          now={now}
          onOpen={onOpen}
          unfolded={unfolded}
          toggle={toggle}
        />
      ));
  const foldButton = node.foldable ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 border-dashed px-2 text-xs text-primary"
      data-testid="overview-group-fold"
      aria-expanded={!folded}
      onClick={() => toggle(run.executionId)}
    >
      {folded
        ? t("pages.overview.group.show", { count: node.descendants })
        : t("pages.overview.group.fold")}
    </Button>
  ) : null;
  const heading =
    depth === 0 ? (
      <>
        <b className="truncate font-semibold text-foreground">{run.title}</b>
        <span className="flex-none">
          · {t("pages.overview.group.children", { count: run.childRuns.length })}
          {node.descendants > run.childRuns.length
            ? `, ${t("pages.overview.group.tree", { count: node.descendants })}`
            : ""}
        </span>
      </>
    ) : (
      <>
        <span className="flex-none rounded-md bg-primary/10 px-1.5 py-px text-[11px] font-bold text-primary">
          {t("pages.overview.group.level", { level: depth + 1 })}
        </span>
        <span className="truncate">
          {t("pages.overview.group.nested", { title: run.title, count: run.childRuns.length })}
        </span>
        {foldButton}
      </>
    );
  return (
    <section
      className={cn(
        "flex min-w-0 gap-4 rounded-2xl border border-border p-3",
        layout === "grid" ? "flex-wrap items-start" : "items-start",
        depth === 0
          ? layout === "grid"
            ? "col-span-full bg-muted/60"
            : "overflow-x-auto bg-muted/60"
          : cn(
              "border-dashed",
              depth === 1 ? "bg-primary/5" : "bg-primary/10",
              layout === "grid" && "basis-full",
            ),
      )}
      aria-label={t("pages.overview.group.label", { title: run.title })}
      data-testid="overview-group"
      data-depth={depth}
      data-run-id={run.executionId}
      data-folded={folded || undefined}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground",
          layout === "grid" ? "basis-full" : "sr-only",
        )}
      >
        {heading}
      </div>
      {layout === "lanes" && foldButton ? (
        <div className="flex-none self-center">{foldButton}</div>
      ) : null}
      <OverviewCard
        run={run}
        parentTitle={depth === 0 ? null : parentTitle}
        now={now}
        onOpen={onOpen}
        className={cardClass}
      />
      {children}
    </section>
  );
}

function NodeView(props: {
  node: BoardNode;
  parentTitle: string | null;
  layout: OverviewLayout;
  now: number;
  onOpen: (id: string) => void;
  unfolded: ReadonlySet<string>;
  toggle: (id: string) => void;
}): React.JSX.Element {
  const { node, parentTitle, layout, now, onOpen } = props;
  if (node.kind === "group") return <GroupView {...props} node={node} />;
  const card = (
    <OverviewCard
      run={node.run}
      parentTitle={node.depth === 0 ? null : parentTitle}
      now={now}
      onOpen={onOpen}
      className={
        layout === "lanes"
          ? "w-[300px] flex-none"
          : node.depth > 0
            ? "w-full sm:w-[300px] sm:flex-none"
            : undefined
      }
    />
  );
  if (layout === "lanes" && node.depth === 0) {
    return <div className="flex overflow-x-auto p-1 pb-2.5">{card}</div>;
  }
  return card;
}

export function OverviewBoard({ runs, layout, now, onOpen }: BoardProps): React.JSX.Element {
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setUnfolded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div
      className={cn(
        layout === "grid"
          ? "grid grid-cols-1 gap-4 sm:grid-cols-[repeat(auto-fill,300px)]"
          : "grid gap-3.5",
      )}
      data-testid="overview-board"
      data-layout={layout}
    >
      {runs.map((run) => (
        <NodeView
          key={run.executionId}
          node={boardNode(run)}
          parentTitle={null}
          layout={layout}
          now={now}
          onOpen={onOpen}
          unfolded={unfolded}
          toggle={toggle}
        />
      ))}
    </div>
  );
}
