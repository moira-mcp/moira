/**
 * Visual language for authored node types, aligned with the app's CompactNode palette so the
 * nodes behind a block look the same here as on the authored graph.
 */

import React from "react";
import {
  ArchiveRestore,
  Bot,
  Code,
  FileEdit,
  FilePlus,
  FileText,
  GitBranch,
  HelpCircle,
  Lock,
  Play,
  Send,
  Square,
  Workflow,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface NodeTypeStyle {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tint: string;
  border: string;
  bg: string;
}

const STYLES: Record<string, NodeTypeStyle> = {
  start: {
    icon: Play,
    label: "START",
    tint: "text-chart-2",
    border: "border-chart-2",
    bg: "bg-chart-2/10",
  },
  "agent-directive": {
    icon: Bot,
    label: "AGENT",
    tint: "text-chart-1",
    border: "border-chart-1",
    bg: "bg-chart-1/10",
  },
  condition: {
    icon: GitBranch,
    label: "IF",
    tint: "text-chart-4",
    border: "border-chart-4",
    bg: "bg-chart-4/10",
  },
  expression: {
    icon: Code,
    label: "EXPR",
    tint: "text-chart-3",
    border: "border-chart-3",
    bg: "bg-chart-3/10",
  },
  teleport: {
    icon: Zap,
    label: "TELEPORT",
    tint: "text-chart-5",
    border: "border-chart-5",
    bg: "bg-chart-5/10",
  },
  materialize: {
    icon: ArchiveRestore,
    label: "MATERIALIZE",
    tint: "text-primary",
    border: "border-primary",
    bg: "bg-primary/10",
  },
  "user-notification": {
    icon: Send,
    label: "NOTIFY",
    tint: "text-chart-3",
    border: "border-chart-3",
    bg: "bg-chart-3/10",
  },
  "telegram-notification": {
    icon: Send,
    label: "NOTIFY",
    tint: "text-chart-3",
    border: "border-chart-3",
    bg: "bg-chart-3/10",
  },
  subgraph: {
    icon: Workflow,
    label: "SUBGRAPH",
    tint: "text-chart-3",
    border: "border-chart-3",
    bg: "bg-chart-3/10",
  },
  lock: {
    icon: Lock,
    label: "LOCK",
    tint: "text-warning-foreground",
    border: "border-warning",
    bg: "bg-warning/10",
  },
  "read-note": {
    icon: FileText,
    label: "READ",
    tint: "text-chart-5",
    border: "border-chart-5",
    bg: "bg-chart-5/10",
  },
  "write-note": {
    icon: FileEdit,
    label: "WRITE",
    tint: "text-chart-5",
    border: "border-chart-5",
    bg: "bg-chart-5/10",
  },
  "upsert-note": {
    icon: FilePlus,
    label: "UPSERT",
    tint: "text-chart-5",
    border: "border-chart-5",
    bg: "bg-chart-5/10",
  },
  end: {
    icon: Square,
    label: "END",
    tint: "text-destructive",
    border: "border-destructive",
    bg: "bg-destructive/10",
  },
};

const FALLBACK: NodeTypeStyle = {
  icon: HelpCircle,
  label: "NODE",
  tint: "text-muted-foreground",
  border: "border-border",
  bg: "bg-muted",
};

export function nodeTypeStyle(type: string): NodeTypeStyle {
  return STYLES[type] ?? FALLBACK;
}

/** Small type tag: icon plus the short type label, in the type's colour. */
export function NodeTypeTag({
  type,
  className,
  fixed = false,
}: {
  type: string;
  className?: string;
  /** One box for every type (the step cards' badge column): same width and height, label centred. */
  fixed?: boolean;
}): React.JSX.Element {
  const style = nodeTypeStyle(type);
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
        fixed && "h-6 w-[84px] justify-center px-1 text-[9px] tracking-normal",
        style.border,
        style.bg,
        style.tint,
        className,
      )}
      data-step-badge={fixed ? type : undefined}
    >
      <Icon className="size-3" aria-hidden="true" />
      {style.label}
    </span>
  );
}
