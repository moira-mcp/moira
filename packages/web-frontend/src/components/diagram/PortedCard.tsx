/**
 * A card with named ports: the edges arriving at it enter through a column of input ports on the
 * left (each naming where it comes from and the transition), the edges leaving it exit through a
 * column of output ports on the right (each naming the output — `success`, a case, `error` — and
 * its target), and every transition back to the card itself shares one double port on the
 * bottom edge. The centre carries only the type badge, the title, a two-line description and a
 * row of fact chips; everything longer (the full directive, the returned fields, the expressions,
 * a transition's condition) is a tooltip. The card is as tall as its longer port column needs.
 *
 * The same card draws a step on the technical graph and, with block-level ports, a block on the
 * map; React Flow handles live inside the port rows, so an edge attaches to its own port.
 */

import React from "react";
import { Handle, Position } from "@xyflow/react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { NodeTypeTag } from "../run/nodeTypeStyle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TemplateText } from "./VariableText";

/** One port: a React Flow handle id, what the row shows and what its tooltip explains. */
export interface PortInfo {
  /** The link id; the handle is `in:<id>` on an input port and `out:<id>` on an output port. */
  id: string;
  /** The port's name: the source step for an input, the output name for an output. */
  label: string;
  /** Secondary text: the transition label, the target name. */
  detail?: string | null;
  kind: "forward" | "return" | "external" | "default" | "error";
  /** The tooltip: the transition's condition, cause and exit, target. */
  tip?: React.ReactNode;
}

export interface FactChip {
  key: string;
  icon?: React.ReactNode;
  label: string;
  count?: number | string;
  tip: React.ReactNode;
}

export interface PortedCardProps {
  type: string;
  title: string;
  /** Shown small beside the title (the node id when the title is the authored label). */
  subtitle?: string | null;
  description?: string | null;
  /** The full description, shown as the description's tooltip when it is longer than two lines. */
  descriptionTip?: React.ReactNode;
  facts: FactChip[];
  inputs: PortInfo[];
  outputs: PortInfo[];
  /** Transitions from the card to itself; all share the bottom double port. */
  selfLoops: PortInfo[];
  /** Ports on the left and right (true) or on the top and bottom (false). */
  horizontal: boolean;
  width: number;
  current?: boolean;
  selected?: boolean;
  error?: boolean;
  /** Something connected to this card is hovered: the card lights with its edges. */
  near?: boolean;
  /** Which port ids are lit under the current focus. */
  litIds?: ReadonlySet<string> | null;
  onHover?: (ids: readonly string[] | null) => void;
  /** Ids of every link the card takes part in, lit together when the card is hovered. */
  allLinkIds: readonly string[];
  children?: React.ReactNode;
  dataAttributes?: Record<string, string | undefined>;
}

/** Height of one port row plus its gap; the card's minimum height follows the longer column. */
export const PORT_ROW = 34;
/** Room the header (badge, title, description, facts) needs before the port columns matter. */
export const PORTED_HEADER = 120;
export const SELF_LOOP_BAND = 36;

const PORT_TONE: Record<PortInfo["kind"], string> = {
  forward: "border-border text-foreground",
  external: "border-border text-foreground",
  default: "border-primary/60 text-primary",
  return: "border-dashed border-amber-500/70 text-amber-600 dark:text-amber-400",
  error: "border-destructive/50 text-destructive",
};

function Port({
  port,
  side,
  lit,
  onHover,
}: {
  port: PortInfo;
  side: "in" | "out" | "loop";
  lit: boolean;
  onHover?: (ids: readonly string[] | null) => void;
}): React.JSX.Element {
  const row = (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 font-mono text-[11px] leading-5 transition-colors",
        PORT_TONE[port.kind],
        lit && "border-primary bg-primary/10",
      )}
      onMouseEnter={() => onHover?.([port.id])}
      onMouseLeave={() => onHover?.(null)}
      data-port={side}
      data-transition={port.id}
      data-lit={lit ? "true" : undefined}
    >
      {port.kind === "return" && <RotateCcw className="size-3 shrink-0" aria-hidden="true" />}
      <span className="shrink-0 truncate" style={{ maxWidth: "70%" }}>
        {port.label}
      </span>
      {port.detail && (
        <span className="min-w-0 truncate font-sans text-[10px] text-muted-foreground">
          {port.detail}
        </span>
      )}
    </div>
  );
  if (!port.tip) return row;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent side={side === "in" ? "left" : side === "out" ? "right" : "bottom"}>
        <TipBody>{port.tip}</TipBody>
      </TooltipContent>
    </Tooltip>
  );
}

/** Tooltip body: wide, left-aligned, keeps line breaks, monospace for authored text. */
export function TipBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="max-w-[440px] whitespace-pre-wrap text-left font-mono text-[11px] leading-[1.5] [text-wrap:initial]">
      {children}
    </div>
  );
}

export function PortedCard({
  type,
  title,
  subtitle,
  description,
  descriptionTip,
  facts,
  inputs,
  outputs,
  selfLoops,
  horizontal,
  width,
  current = false,
  selected = false,
  error = false,
  near = false,
  litIds = null,
  onHover,
  allLinkIds,
  children,
  dataAttributes,
}: PortedCardProps): React.JSX.Element {
  const rows = Math.max(inputs.length, outputs.length, 1);
  const minHeight = horizontal
    ? Math.max(PORTED_HEADER, rows * PORT_ROW + 24) + (selfLoops.length ? SELF_LOOP_BAND : 0)
    : undefined;
  const litOf = (id: string) => litIds?.has(id) ?? false;
  const column = (ports: PortInfo[], side: "in" | "out") => (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-evenly gap-1.5 px-2 py-2",
        side === "in" ? "border-r border-dashed" : "border-l border-dashed",
        !horizontal && "flex-row flex-wrap border-0",
      )}
      data-ports={side}
    >
      {ports.map((port) => (
        <div key={port.id} className="relative min-w-0">
          <Handle
            type={side === "in" ? "target" : "source"}
            position={
              horizontal
                ? side === "in"
                  ? Position.Left
                  : Position.Right
                : side === "in"
                  ? Position.Top
                  : Position.Bottom
            }
            id={`${side}:${port.id}`}
            className={cn(
              "!size-2.5 !border-2 !bg-card",
              litOf(port.id) ? "!border-primary" : "!border-muted-foreground",
              port.kind === "return" && "!border-amber-500",
            )}
            style={horizontal ? { top: "50%" } : { left: "50%" }}
          />
          <Port port={port} side={side} lit={litOf(port.id)} onHover={onHover} />
        </div>
      ))}
    </div>
  );
  return (
    <div
      style={{ width, minHeight }}
      onMouseEnter={() => allLinkIds.length > 0 && onHover?.(allLinkIds)}
      onMouseLeave={() => onHover?.(null)}
      className={cn(
        "relative flex flex-col rounded-xl border bg-card text-sm shadow-sm transition-shadow",
        current && "border-primary/50",
        (near || selected) && "ring-2 ring-primary/60",
        error && "ring-2 ring-destructive",
      )}
      {...dataAttributes}
    >
      <div
        className={cn(
          "grid min-h-0 flex-1",
          horizontal
            ? "grid-cols-[minmax(150px,1fr)_minmax(0,1.6fr)_minmax(150px,1fr)]"
            : "grid-cols-1",
        )}
      >
        {column(inputs, "in")}
        <div className="min-w-0 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <NodeTypeTag type={type} />
            {current && (
              <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold leading-4 text-primary-foreground">
                •
              </span>
            )}
          </div>
          <div
            className="mt-1.5 truncate text-[14px] font-semibold leading-tight"
            data-step-title=""
          >
            <TemplateText text={title} />
            {subtitle && (
              <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">
                {subtitle}
              </span>
            )}
          </div>
          {description &&
            (descriptionTip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="mt-1 line-clamp-2 cursor-help text-xs leading-5 text-muted-foreground">
                    <TemplateText text={description} />
                  </p>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <TipBody>{descriptionTip}</TipBody>
                </TooltipContent>
              </Tooltip>
            ) : (
              <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                <TemplateText text={description} />
              </p>
            ))}
          {facts.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5" data-step-facts="">
              {facts.map((fact) => (
                <Tooltip key={fact.key}>
                  <TooltipTrigger asChild>
                    <span className="inline-flex cursor-help items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-[11px] leading-4 hover:border-primary">
                      {fact.icon}
                      {fact.label}
                      {fact.count !== undefined && (
                        <b className="font-semibold text-primary">{fact.count}</b>
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <TipBody>{fact.tip}</TipBody>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          )}
          {children}
        </div>
        {column(outputs, "out")}
      </div>
      {selfLoops.length > 0 && (
        <div
          className="relative flex flex-wrap items-center justify-center gap-1.5 rounded-b-xl border-t border-dashed bg-muted/40 px-3 pb-2.5 pt-2"
          data-ports="loop"
        >
          {selfLoops.map((port) => (
            <Port key={port.id} port={port} side="loop" lit={litOf(port.id)} onHover={onHover} />
          ))}
          {/* One double port for every self-loop: the edge leaves the left dot and re-enters the right one. */}
          {selfLoops.map((port, index) => (
            <React.Fragment key={`h:${port.id}`}>
              <Handle
                type="source"
                position={Position.Bottom}
                id={`out:${port.id}`}
                className={cn(
                  "!size-2.5 !border-2 !bg-card !border-amber-500",
                  index > 0 && "!opacity-0",
                )}
                style={{ left: "calc(50% - 9px)" }}
              />
              <Handle
                type="target"
                position={Position.Bottom}
                id={`in:${port.id}`}
                className={cn(
                  "!size-2.5 !border-2 !bg-card !border-amber-500",
                  index > 0 && "!opacity-0",
                )}
                style={{ left: "calc(50% + 9px)" }}
              />
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
