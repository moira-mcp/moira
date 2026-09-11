/**
 * Editing affordances the views render only while the flow page's edit mode is on. Everything
 * here edits the definition through the editing context; nothing touches a run.
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle } from "lucide-react";
import { diagnosticsFor, useEditing, type NodeTextField } from "./editing";
import type { RunBlock, RunTransition, StepInfo } from "../run/model";

/** Renders `value` as text, or as an input/textarea while editing; commits on every change. */
export function EditableText({
  value,
  onChange,
  multiline,
  className,
  inputClassName,
  testId,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  multiline?: boolean;
  className?: string;
  inputClassName?: string;
  testId?: string;
  /** What to render when not editing (defaults to the value). */
  children?: React.ReactNode;
}): React.JSX.Element {
  const { enabled } = useEditing();
  if (!enabled) return <span className={className}>{children ?? value}</span>;
  const shared = cn(
    "nodrag nopan w-full rounded-md border-dashed bg-background/80 font-[inherit] text-[inherit] leading-[inherit]",
    inputClassName,
  );
  return multiline ? (
    <Textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className={cn(shared, "min-h-[72px] resize-y")}
      data-testid={testId}
      data-edit-field="true"
    />
  ) : (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className={cn(shared, "h-8 px-2")}
      data-testid={testId}
      data-edit-field="true"
    />
  );
}

/** Block name and description, editable in place. */
export function BlockNameEditor({ block }: { block: RunBlock }): React.JSX.Element {
  const { setBlock } = useEditing();
  return (
    <EditableText
      value={block.name}
      onChange={(label) => setBlock(block.id, { label })}
      testId={`edit-block-label-${block.id}`}
    />
  );
}

export function BlockSummaryEditor({
  block,
  className,
}: {
  block: RunBlock;
  className?: string;
}): React.JSX.Element {
  const { setBlock } = useEditing();
  return (
    <EditableText
      value={block.description}
      onChange={(summary) => setBlock(block.id, { summary })}
      multiline
      className={className}
      testId={`edit-block-summary-${block.id}`}
    />
  );
}

/** Pencil that opens a popover to edit a transition's label and, for returns, its cause and exit. */
export function TransitionEditor({
  transition,
  className,
}: {
  transition: RunTransition;
  className?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, setLabel } = useEditing();
  const [open, setOpen] = useState(false);
  if (!enabled || !transition.edges?.length) return null;
  const commit = (patch: { label?: string; cause?: string; exit?: string }): void => {
    const label = patch.label ?? transition.label;
    if (transition.cycle) {
      setLabel(transition.edges, {
        label,
        cycle: {
          cause: patch.cause ?? transition.cycle.cause,
          exit: patch.exit ?? transition.cycle.exit,
        },
      });
    } else setLabel(transition.edges, label);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "nodrag nopan inline-flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          aria-label={t("pages.flowPage.edit.editTransition")}
          data-testid="edit-transition"
          data-edges={transition.edges.join(",")}
          onClick={(e) => e.stopPropagation()}
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-96 space-y-3 text-sm"
        onClick={(e) => e.stopPropagation()}
        data-testid="edit-transition-popover"
      >
        <p className="text-xs text-muted-foreground">
          {t("pages.flowPage.edit.transitionEdges", { edges: transition.edges.join(", ") })}
        </p>
        <label className="block space-y-1">
          <span className="text-xs font-medium">{t("pages.flowPage.edit.label")}</span>
          <Input
            value={transition.label}
            onChange={(e) => commit({ label: e.target.value })}
            data-testid="edit-transition-label"
          />
        </label>
        {transition.cycle && (
          <>
            <label className="block space-y-1">
              <span className="text-xs font-medium">{t("pages.flowPage.edit.cause")}</span>
              <Textarea
                value={transition.cycle.cause}
                onChange={(e) => commit({ cause: e.target.value })}
                className="min-h-[60px]"
                data-testid="edit-transition-cause"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">{t("pages.flowPage.edit.exit")}</span>
              <Textarea
                value={transition.cycle.exit}
                onChange={(e) => commit({ exit: e.target.value })}
                className="min-h-[60px]"
                data-testid="edit-transition-exit"
              />
            </label>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Select that moves an authored node to another block. */
export function OwnerSelect({
  nodeId,
  currentBlockId,
  blocks,
}: {
  nodeId: string;
  currentBlockId: string;
  blocks: RunBlock[];
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, setOwner } = useEditing();
  if (!enabled) return null;
  return (
    <Select value={currentBlockId} onValueChange={(value) => setOwner(nodeId, value)}>
      <SelectTrigger
        className="h-7 w-[200px] text-xs"
        aria-label={t("pages.flowPage.edit.moveNode")}
        data-testid={`edit-owner-${nodeId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {blocks.map((b) => (
          <SelectItem key={b.id} value={b.id}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Which authored text fields a step of this type carries. */
export function editableFields(step: StepInfo): NodeTextField[] {
  switch (step.type) {
    case "agent-directive":
      return ["directive", "completionCondition"];
    case "user-notification":
    case "telegram-notification":
      return ["message"];
    case "expression":
      return ["expressions"];
    default:
      return [];
  }
}

/** The authored text of a step (directive and completion condition, message, or expressions), editable. */
export function NodeTextEditor({
  step,
  node,
}: {
  step: StepInfo;
  /** The node as currently edited. */
  node: Record<string, unknown>;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, setNodeField } = useEditing();
  const fields = editableFields(step);
  if (!enabled || fields.length === 0) return null;
  return (
    <div className="mt-2 space-y-2" data-testid={`edit-node-${step.id}`}>
      {fields.map((field) => {
        const raw = node[field];
        const value =
          field === "expressions"
            ? Array.isArray(raw)
              ? (raw as string[]).join("\n")
              : ""
            : typeof raw === "string"
              ? raw
              : "";
        return (
          <label key={field} className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t(`pages.flowPage.edit.fields.${field}`)}
            </span>
            <Textarea
              value={value}
              onChange={(e) =>
                setNodeField(
                  step.id,
                  field,
                  field === "expressions" ? e.target.value.split("\n") : e.target.value,
                )
              }
              onClick={(e) => e.stopPropagation()}
              className="min-h-[80px] font-mono text-xs"
              data-testid={`edit-node-${step.id}-${field}`}
              data-edit-field="true"
            />
          </label>
        );
      })}
    </div>
  );
}

/** The derivation diagnostics that point at one block or step, shown next to it. */
export function DiagnosticBadge({
  blockId,
  nodeId,
  className,
}: {
  blockId?: string;
  nodeId?: string;
  className?: string;
}): React.JSX.Element | null {
  const { diagnostics } = useEditing();
  const own = diagnosticsFor(diagnostics, { blockId, nodeId });
  if (own.length === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-start gap-1 rounded-md border border-destructive/50 bg-destructive/10 px-1.5 py-0.5 text-[11px] leading-4 text-destructive",
        className,
      )}
      role="alert"
      data-testid="inline-diagnostic"
      data-diagnostic={own.map((d) => d.code).join(",")}
      title={own.map((d) => d.message).join("\n")}
    >
      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {own.map((d) => (
          <span key={`${d.code}-${d.edge ?? ""}`} className="block">
            <span className="font-mono">{d.code}</span>: {d.message}
          </span>
        ))}
      </span>
    </span>
  );
}
