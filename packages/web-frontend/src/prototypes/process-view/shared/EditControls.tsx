/**
 * Editing affordances the views render only while authoring mode is on. Everything here edits the
 * flow definition through the editing context; nothing touches a run.
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
import { useEditing } from "../editing";
import type { ProcessBlock, Transition } from "../model";

/** Renders `value` as text, or as an input/textarea while editing; commits on every change. */
export function EditableText({
  value,
  onChange,
  multiline,
  className,
  inputClassName,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  multiline?: boolean;
  className?: string;
  inputClassName?: string;
  testId?: string;
}): React.JSX.Element {
  const { enabled } = useEditing();
  if (!enabled) return <span className={className}>{value}</span>;
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

/** Pencil that opens a popover to edit a transition's label and, for returns, its cause and exit. */
export function TransitionEditor({
  transition,
  className,
}: {
  transition: Transition;
  className?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, setLabel } = useEditing();
  const [open, setOpen] = useState(false);
  if (!enabled || !transition.edges?.length) return null;
  const commit = (patch: { label?: string; cause?: string; exit?: string }): void => {
    const label = patch.label ?? transition.label;
    if (transition.cycle) {
      setLabel(transition.edges!, {
        label,
        cycle: {
          cause: patch.cause ?? transition.cycle.cause,
          exit: patch.exit ?? transition.cycle.exit,
        },
      });
    } else setLabel(transition.edges!, label);
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
          aria-label={t("pages.processViewPrototype.edit.editTransition")}
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
          {t("pages.processViewPrototype.edit.transitionEdges", {
            edges: transition.edges.join(", "),
          })}
        </p>
        <label className="block space-y-1">
          <span className="text-xs font-medium">{t("pages.processViewPrototype.edit.label")}</span>
          <Input
            value={transition.label}
            onChange={(e) => commit({ label: e.target.value })}
            data-testid="edit-transition-label"
          />
        </label>
        {transition.cycle && (
          <>
            <label className="block space-y-1">
              <span className="text-xs font-medium">
                {t("pages.processViewPrototype.edit.cause")}
              </span>
              <Textarea
                value={transition.cycle.cause}
                onChange={(e) => commit({ cause: e.target.value })}
                className="min-h-[60px]"
                data-testid="edit-transition-cause"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">
                {t("pages.processViewPrototype.edit.exit")}
              </span>
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
  blocks: ProcessBlock[];
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { enabled, setOwner } = useEditing();
  if (!enabled) return null;
  return (
    <Select value={currentBlockId} onValueChange={(value) => setOwner(nodeId, value)}>
      <SelectTrigger
        className="h-7 w-[200px] text-xs"
        aria-label={t("pages.processViewPrototype.edit.moveNode")}
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
