/**
 * Outline — the process as a document.
 *
 * No layout engine: the process reads top to bottom as numbered sections. Each section is one
 * block with its status, its description, its run content, its transitions stated in words —
 * including cycles with their cause and what ends them — what its steps wrote, and a collapsible
 * list of the steps that implement it with the evidence each demands. A table of contents on the
 * left mirrors the sections and shows status at a glance.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronDown, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusChip, StatusIcon, STATUS_STYLE } from "./status";
import { GuidanceCallout } from "./Guidance";
import { StepList } from "./StepList";
import { useEditing, useModeGuideKey } from "../flow/editing";
import {
  BlockNameEditor,
  BlockSummaryEditor,
  DiagnosticBadge,
  TransitionEditor,
} from "../flow/EditControls";
import {
  blockById,
  blockWrites,
  formatValue,
  stepsOf,
  type RunBlock,
  type RunViewProps,
} from "./model";

function Section({
  block,
  blocks,
  selected,
  onSelect,
  progress,
  workflow,
  cursor,
}: {
  block: RunBlock;
  blocks: RunBlock[];
  selected: boolean;
  onSelect: (id: string | null) => void;
} & Pick<RunViewProps, "progress" | "workflow" | "cursor">): React.JSX.Element {
  const { t } = useTranslation();
  const { enabled: editing } = useEditing();
  const byId = blockById(blocks);
  const style = STATUS_STYLE[block.status];
  const [open, setOpen] = React.useState(selected);
  React.useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);
  const steps = React.useMemo(() => stepsOf(workflow, block.nodeIds), [workflow, block.nodeIds]);
  const writes = React.useMemo(
    () => blockWrites(progress, block.id, cursor),
    [progress, block.id, cursor],
  );
  const { content } = block;

  return (
    <section
      id={`outline-${block.id}`}
      aria-labelledby={`outline-${block.id}-title`}
      className={cn(
        "scroll-mt-24 rounded-xl border-l-4 py-1 pl-4 transition",
        style.surface.split(" ").find((c) => c.startsWith("border-")) ?? "border-border",
        selected && "bg-accent/40",
      )}
      data-block-id={block.id}
      data-status={block.status}
      data-testid={`progress-node-${block.id}`}
      aria-current={block.status === "active" || block.status === "waiting" ? "step" : undefined}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3
          id={`outline-${block.id}-title`}
          className="min-w-0 flex-1 text-lg font-semibold leading-7"
        >
          {editing ? (
            <span className="flex items-center gap-2">
              <span className="tabular-nums text-muted-foreground">{block.index + 1}.</span>
              <BlockNameEditor block={block} />
            </span>
          ) : (
            <button
              type="button"
              className={cn(
                "text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                block.status === "skipped" && "line-through decoration-muted-foreground/60",
              )}
              onClick={() => onSelect(selected ? null : block.id)}
              aria-pressed={selected}
            >
              <span className="mr-2 tabular-nums text-muted-foreground">{block.index + 1}.</span>
              {block.name}
            </button>
          )}
        </h3>
        {!editing && <StatusChip status={block.status} iterations={block.iterations} />}
        <DiagnosticBadge blockId={block.id} />
      </header>

      {editing ? (
        <BlockSummaryEditor block={block} className="mt-2 block max-w-3xl text-[15px] leading-7" />
      ) : (
        <p className="mt-2 max-w-3xl text-[15px] leading-7 text-foreground/90">
          {block.description}
        </p>
      )}
      {(content.summary || content.details.length > 0 || content.outcome || content.next) && (
        <dl className="mt-1 max-w-3xl space-y-0.5 text-sm">
          {content.summary && <dd className="font-medium">{content.summary}</dd>}
          {content.details.map((detail, index) => (
            <dd key={index} className="text-muted-foreground">
              • {detail}
            </dd>
          ))}
          {content.outcome && <dd className="text-success">✓ {content.outcome}</dd>}
          {content.next && <dd className="font-medium text-primary">→ {content.next}</dd>}
        </dl>
      )}
      {writes.length > 0 && (
        <div
          className="mt-2 flex flex-wrap items-center gap-1 text-[11px]"
          data-testid={`block-writes-${block.id}`}
        >
          <span className="mr-1 text-muted-foreground">{t("pages.runPage.variables.wrote")}</span>
          {writes.map((w) => (
            <span
              key={w.name}
              className={cn(
                "inline-flex max-w-[280px] items-center gap-1 truncate rounded-md border bg-background px-1.5 font-mono leading-5",
                w.adjusted && "border-warning bg-warning/10",
              )}
              title={`${w.name} = ${formatValue(w.value)} (#${w.seq})`}
              data-block-write={w.name}
            >
              <span className="text-muted-foreground">{w.name}</span>
              <span>= {formatValue(w.value)}</span>
              <span className="text-muted-foreground">#{w.seq}</span>
            </span>
          ))}
        </div>
      )}

      {block.transitions.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {block.transitions.map((transition) => {
            const target = byId.get(transition.to);
            return (
              <li
                key={`${transition.to}-${transition.label}`}
                className="flex items-start gap-2 leading-6"
                data-transition-kind={transition.cycle ? "cycle" : "forward"}
              >
                {transition.cycle ? (
                  <RotateCcw className="mt-1.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <ArrowRight
                    className="mt-1.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span>
                  <span className={cn("font-medium", transition.cycle && "text-primary")}>
                    {transition.label}
                  </span>
                  <TransitionEditor transition={transition} className="ml-1 align-text-bottom" />
                  <span className="text-muted-foreground">
                    {" "}
                    {t(
                      transition.cycle
                        ? "pages.runPage.outline.returnsTo"
                        : "pages.runPage.outline.goesTo",
                    )}{" "}
                  </span>
                  <a
                    href={`#outline-${transition.to}`}
                    className="font-medium underline-offset-2 hover:underline"
                    onClick={(event) => {
                      event.preventDefault();
                      onSelect(transition.to);
                      document
                        .getElementById(`outline-${transition.to}`)
                        ?.scrollIntoView({ block: "start", behavior: "smooth" });
                    }}
                  >
                    {target?.name ?? transition.to}
                  </a>
                  {transition.cycle && (
                    <span className="text-muted-foreground">
                      {" "}
                      — {transition.cycle.cause} {t("pages.runPage.lanes.endsWhen")}{" "}
                      {transition.cycle.exit}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
        <CollapsibleTrigger
          className="inline-flex items-center gap-1 rounded-md px-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`outline-steps-toggle-${block.id}`}
        >
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
          {t("pages.runPage.stepCount", { count: block.nodeIds.length })}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <StepList steps={steps} currentNodeId={block.currentNodeId} className="mt-2" />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export function OutlineView(props: RunViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const guideKey = useModeGuideKey();
  const { blocks, selectedBlockId, onSelectBlock } = props;
  return (
    <div className="scrollbar-thin h-full space-y-4 overflow-auto p-4" data-testid="outline-view">
      <GuidanceCallout title={t(`${guideKey}.outline.title`)} testId="guidance-outline">
        {t(`${guideKey}.outline.body`)}
      </GuidanceCallout>
      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          aria-label={t("pages.runPage.outline.contents")}
          className="lg:sticky lg:top-0 lg:self-start"
        >
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pages.runPage.outline.contents")}
          </p>
          <ol className="space-y-0.5">
            {blocks.map((block) => (
              <li key={block.id}>
                <a
                  href={`#outline-${block.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onSelectBlock(block.id);
                    document
                      .getElementById(`outline-${block.id}`)
                      ?.scrollIntoView({ block: "start", behavior: "smooth" });
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent",
                    selectedBlockId === block.id && "bg-accent font-medium",
                    block.status === "skipped" && "text-muted-foreground line-through",
                    block.status === "pending" && "text-muted-foreground",
                  )}
                  aria-current={
                    block.status === "active" || block.status === "waiting" ? "step" : undefined
                  }
                >
                  <StatusIcon status={block.status} className="size-3.5" />
                  <span className="tabular-nums text-muted-foreground">{block.index + 1}.</span>
                  <span className="truncate">{block.name}</span>
                  {block.status === "repeated" && block.iterations ? (
                    <span className="ml-auto text-[11px] tabular-nums text-success">
                      ×{block.iterations}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="max-w-3xl space-y-8" data-testid="outline-document">
          {blocks.map((block) => (
            <Section
              key={block.id}
              block={block}
              blocks={blocks}
              selected={selectedBlockId === block.id}
              onSelect={onSelectBlock}
              progress={props.progress}
              workflow={props.workflow}
              cursor={props.cursor}
            />
          ))}
        </article>
      </div>
    </div>
  );
}
