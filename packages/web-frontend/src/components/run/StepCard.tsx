/**
 * One step as a card, the same card wherever a block's steps are listed: the run page's block
 * panel, the outline, the flow page's split view (and the technical graph). Every card has one
 * geometry — an optional position column, a type badge column of one width and height, and a
 * body whose title and first line start at the same x and y in every card — so a list of steps
 * reads as one grid. The body carries the first sentence of the directive, the evidence the step
 * returns, the edges arriving at it that its surface names rather than draws (the graph's arrival
 * chips), its connections as chips that wrap inside the body, and slots for what a surface adds
 * (the split view's owner select, diagnostics and editor; the run page's "current" marker).
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownRight, ArrowUpRight, CornerLeftDown, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { NodeTypeTag } from "./nodeTypeStyle";
import { TemplateText } from "../diagram/VariableText";
import type { StepArrival, StepConnection, StepInfo } from "./model";

export function StepCardList({
  children,
  className,
  testId,
  listRef,
  ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  testId?: string;
  listRef?: React.Ref<HTMLOListElement>;
  ariaLabel?: string;
}): React.JSX.Element {
  return (
    <ol
      ref={listRef}
      className={cn("space-y-2", className)}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {children}
    </ol>
  );
}

export function StepCard({
  step,
  position,
  current = false,
  highlighted = false,
  connections = [],
  arrivals = [],
  onArrival,
  onArrivalHover,
  onConnection,
  onConnectionHover,
  onSelect,
  selectTitle,
  afterTitle,
  beforeSummary,
  footer,
  id,
}: {
  step: StepInfo;
  /** One-based position in the block, shown in a fixed column when given. */
  position?: number;
  /** The run is on this step. */
  current?: boolean;
  highlighted?: boolean;
  connections?: StepConnection[];
  /** Edges arriving here that the surface names instead of drawing; shown as chips before them. */
  arrivals?: StepArrival[];
  onArrival?: (arrival: StepArrival) => void;
  onArrivalHover?: (arrival: StepArrival | null) => void;
  onConnection?: (connection: StepConnection) => void;
  /** Hovering a connection chip (or leaving it): the graph lights the matching edge. */
  onConnectionHover?: (connection: StepConnection | null) => void;
  /** Makes the card a button (the run page focuses the step on the node graph). */
  onSelect?: () => void;
  selectTitle?: string;
  afterTitle?: React.ReactNode;
  beforeSummary?: React.ReactNode;
  footer?: React.ReactNode;
  id?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const Body: "button" | "div" = onSelect ? "button" : "div";
  return (
    <li
      id={id}
      className={cn(
        "rounded-lg border bg-card text-sm transition-colors",
        current && "border-primary/40 bg-primary/5",
        highlighted && "bg-accent",
      )}
      data-node-id={step.id}
      data-step-card=""
      aria-current={current ? "step" : undefined}
    >
      <Body
        {...(onSelect ? { type: "button" as const, onClick: onSelect } : {})}
        className={cn(
          "grid w-full items-start gap-x-3 px-3 py-2.5 text-left",
          position === undefined
            ? "grid-cols-[84px_minmax(0,1fr)]"
            : "grid-cols-[1.25rem_84px_minmax(0,1fr)]",
          onSelect &&
            "rounded-lg hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        title={selectTitle}
      >
        {position !== undefined && (
          <span className="pt-0.5 text-right text-[11px] leading-5 tabular-nums text-muted-foreground">
            {position}
          </span>
        )}
        <NodeTypeTag type={step.type} fixed />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 leading-6">
            <span className="font-mono text-xs font-medium leading-6" data-step-title="">
              {step.displayName ?? step.id}
              {step.displayName && (
                <span className="ml-1 font-normal text-muted-foreground">({step.id})</span>
              )}
            </span>
            {afterTitle}
            {current && (
              <span className="ml-auto shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold leading-4 text-primary-foreground">
                {t("pages.runPage.blockDetail.current")}
              </span>
            )}
          </div>
          {beforeSummary}
          {step.summary && (
            <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              <TemplateText text={step.summary} />
            </p>
          )}
          {step.evidence.length > 0 && (
            <p
              className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground"
              data-node-inputs={step.evidence.map((field) => field.name).join(",")}
            >
              <span>{t("pages.runPage.blockDetail.returns")}</span>
              {step.evidence.map((field) => (
                <span
                  key={field.name}
                  className={cn(
                    "rounded border bg-background px-1 font-mono leading-4",
                    field.required && "border-foreground/40",
                  )}
                  title={field.description ?? undefined}
                >
                  {field.name}
                  {field.type && <span className="text-muted-foreground">: {field.type}</span>}
                </span>
              ))}
            </p>
          )}
          {arrivals.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1" data-step-arrivals="">
              {arrivals.map((arrival) => (
                <button
                  key={arrival.linkId}
                  type="button"
                  data-arrival={arrival.linkId}
                  title={`${arrival.sourceName} · ${arrival.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onArrival?.(arrival);
                  }}
                  onMouseEnter={onArrivalHover ? () => onArrivalHover(arrival) : undefined}
                  onMouseLeave={onArrivalHover ? () => onArrivalHover(null) : undefined}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[10px] leading-4 transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    arrival.isReturn
                      ? "border-primary/40 text-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {arrival.isReturn ? (
                    <RotateCcw className="size-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <CornerLeftDown className="size-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate opacity-80">{arrival.sourceName}</span>
                  {arrival.sourceBlockName && (
                    <span className="shrink-0 font-medium">{arrival.sourceBlockName}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {connections.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1" data-step-connections="">
              {connections.map((connection) => {
                const Chip: "button" | "span" = onConnection ? "button" : "span";
                return (
                  <Chip
                    key={`${connection.label}-${connection.target}`}
                    {...(onConnection
                      ? {
                          type: "button" as const,
                          onClick: (event: React.MouseEvent) => {
                            event.stopPropagation();
                            onConnection(connection);
                          },
                        }
                      : {})}
                    data-edge-kind={connection.internal ? "internal" : "external"}
                    data-connection={connection.label}
                    title={connection.targetName}
                    onMouseEnter={
                      onConnectionHover ? () => onConnectionHover(connection) : undefined
                    }
                    onMouseLeave={onConnectionHover ? () => onConnectionHover(null) : undefined}
                    className={cn(
                      "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] leading-4 transition",
                      onConnection &&
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      connection.internal
                        ? "border-border bg-background text-muted-foreground"
                        : "border-primary/40 bg-primary/5 text-primary",
                      onConnection &&
                        (connection.internal ? "hover:bg-accent" : "hover:bg-primary/10"),
                    )}
                  >
                    {connection.internal ? (
                      <ArrowDownRight className="size-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
                    )}
                    <span className="font-medium">{connection.label}</span>
                    <span className="truncate opacity-80">{connection.targetName}</span>
                  </Chip>
                );
              })}
            </div>
          )}
          {footer}
        </div>
      </Body>
    </li>
  );
}
