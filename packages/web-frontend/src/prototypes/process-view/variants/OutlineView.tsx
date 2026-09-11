/**
 * Outline variant — the process as a document.
 *
 * No layout engine: the process reads top to bottom as numbered sections. Each section is one
 * block with its status, its description, its transitions stated in words — including cycles with
 * their cause and what ends them — and a collapsible list of the authored nodes that implement it.
 * A table of contents on the left mirrors the sections and shows status at a glance.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronDown, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusChip, StatusIcon, STATUS_STYLE } from "../shared/status";
import { NodeTypeTag } from "../shared/nodeTypeStyle";
import { EditableText, OwnerSelect, TransitionEditor } from "../shared/EditControls";
import { useEditing } from "../editing";
import { BlockVariables } from "../shared/VariablesPanel";
import { GuidanceCallout } from "../shared/Guidance";
import type { RunTrace } from "../trace";
import type { VariantProps } from "../shared/BlockCards";
import {
  blockById,
  nodeById,
  runStateOf,
  type ProcessBlock,
  type ProcessProjection,
} from "../model";

function Section({
  projection,
  block,
  index,
  selected,
  onSelect,
  trace,
  cursor,
}: {
  projection: ProcessProjection;
  block: ProcessBlock;
  index: number;
  selected: boolean;
  onSelect: (id: string | null) => void;
  trace?: RunTrace | null;
  cursor?: number | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const blocks = blockById(projection);
  const nodes = nodeById(projection);
  const state = runStateOf(projection, block.id);
  const style = STATUS_STYLE[state.status];
  const editing = useEditing();
  const [open, setOpen] = React.useState(selected);
  React.useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);

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
      data-status={state.status}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={`outline-${block.id}-title`} className="text-lg font-semibold leading-7">
          <button
            type="button"
            className="text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelect(selected ? null : block.id)}
            aria-pressed={selected}
          >
            <span className="mr-2 tabular-nums text-muted-foreground">{index + 1}.</span>
            <EditableText
              value={block.name}
              onChange={(v) => editing.setBlock(block.id, { label: v })}
              inputClassName="inline-block w-auto min-w-[240px]"
              testId={`edit-block-name-${block.id}`}
            />
          </button>
        </h3>
        <StatusChip state={state} />
        {state.note && <span className="text-sm text-muted-foreground">{state.note}</span>}
      </header>

      <p className="mt-2 max-w-3xl text-[15px] leading-7 text-foreground/90">
        <EditableText
          value={block.description}
          onChange={(v) => editing.setBlock(block.id, { summary: v })}
          multiline
          testId={`edit-block-description-${block.id}`}
        />
      </p>
      <BlockVariables
        projection={projection}
        trace={trace}
        cursor={cursor}
        blockId={block.id}
        className="mt-2"
      />

      {block.transitions.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {block.transitions.map((transition) => {
            const target = blocks.get(transition.to);
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
                  {transition.cycle ? (
                    <>
                      <span className="font-medium text-primary">{transition.label}</span>
                      <TransitionEditor transition={transition} className="ml-1 align-middle" />
                      <span className="text-muted-foreground">
                        {" "}
                        {t("pages.processViewPrototype.outline.returnsTo")}{" "}
                      </span>
                      <a
                        href={`#outline-${transition.to}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {target?.name ?? transition.to}
                      </a>
                      <span className="text-muted-foreground">
                        {" "}
                        — {transition.cycle.cause}{" "}
                        {t("pages.processViewPrototype.outline.endsWhen")} {transition.cycle.exit}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{transition.label}</span>
                      <TransitionEditor transition={transition} className="ml-1 align-middle" />
                      <span className="text-muted-foreground">
                        {" "}
                        {t("pages.processViewPrototype.outline.goesTo")}{" "}
                      </span>
                      <a
                        href={`#outline-${transition.to}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {target?.name ?? transition.to}
                      </a>
                    </>
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
          data-testid={`outline-nodes-toggle-${block.id}`}
        >
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
          {t("pages.processViewPrototype.outline.nodes", { count: block.nodeIds.length })}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="mt-2 divide-y rounded-lg border bg-card">
            {block.nodeIds.map((nodeId) => {
              const node = nodes.get(nodeId);
              const isCurrent = state.currentNodeId === nodeId;
              return (
                <li
                  key={nodeId}
                  className={cn(
                    "flex items-start gap-3 px-3 py-2 text-sm",
                    isCurrent && "bg-primary/5",
                  )}
                  data-node-id={nodeId}
                  aria-current={isCurrent ? "step" : undefined}
                >
                  <NodeTypeTag type={node?.type ?? "unknown"} className="mt-0.5" />
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-foreground">{nodeId}</p>
                    {node?.summary && (
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                        {node.summary}
                      </p>
                    )}
                    {node?.inputs?.length ? (
                      <p
                        className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground"
                        data-node-inputs={node.inputs.join(",")}
                      >
                        <span>{t("pages.processViewPrototype.outline.returns")}</span>
                        {node.inputs.map((field) => (
                          <span
                            key={field}
                            className="rounded border bg-background px-1 font-mono leading-4"
                          >
                            {field}
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                  {isCurrent && (
                    <span className="ml-auto shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                      {t("pages.processViewPrototype.outline.current")}
                    </span>
                  )}
                  <span className={cn("shrink-0", !isCurrent && "ml-auto")}>
                    <OwnerSelect
                      nodeId={nodeId}
                      currentBlockId={block.id}
                      blocks={projection.blocks}
                    />
                  </span>
                </li>
              );
            })}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export function OutlineView({
  projection,
  selectedBlockId,
  onSelectBlock,
  trace,
  cursor,
}: VariantProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <GuidanceCallout
        title={t("pages.processViewPrototype.modeGuide.outline.title")}
        testId="guidance-outline"
      >
        {t("pages.processViewPrototype.modeGuide.outline.body")}
      </GuidanceCallout>
      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          aria-label={t("pages.processViewPrototype.outline.contents")}
          className="lg:sticky lg:top-6 lg:self-start"
        >
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pages.processViewPrototype.outline.contents")}
          </p>
          <ol className="space-y-0.5">
            {projection.blocks.map((block, index) => {
              const state = runStateOf(projection, block.id);
              return (
                <li key={block.id}>
                  <a
                    href={`#outline-${block.id}`}
                    onClick={() => onSelectBlock(block.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent",
                      selectedBlockId === block.id && "bg-accent font-medium",
                      state.status === "skipped" && "text-muted-foreground line-through",
                      state.status === "pending" && "text-muted-foreground",
                    )}
                    aria-current={state.status === "active" ? "step" : undefined}
                  >
                    <StatusIcon status={state.status} className="size-3.5" />
                    <span className="tabular-nums text-muted-foreground">{index + 1}.</span>
                    <span className="truncate">{block.name}</span>
                    {state.status === "repeated" && state.iterations ? (
                      <span className="ml-auto text-[11px] tabular-nums text-success">
                        ×{state.iterations}
                      </span>
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>

        <article className="max-w-3xl space-y-8" data-testid="outline-document">
          {projection.blocks.map((block, index) => (
            <Section
              key={block.id}
              projection={projection}
              block={block}
              index={index}
              selected={selectedBlockId === block.id}
              onSelect={onSelectBlock}
              trace={trace}
              cursor={cursor}
            />
          ))}
        </article>
      </div>
    </div>
  );
}
