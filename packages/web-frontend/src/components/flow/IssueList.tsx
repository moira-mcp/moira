/**
 * A compact list of problems placed on one block, step, transition or graph card: errors in the
 * destructive tone, a list of warnings only in the warning tone. A process diagnostic keeps its
 * code in front of the message, since the flow-file reference names it.
 */

import React from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlacedIssue } from "./issues";

export function IssueList({
  issues,
  className,
}: {
  issues: readonly PlacedIssue[];
  className?: string;
}): React.JSX.Element | null {
  if (issues.length === 0) return null;
  const errors = issues.some((i) => i.severity === "error");
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-start gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4",
        errors
          ? "border-destructive/50 bg-destructive/10 text-destructive"
          : "border-warning/60 bg-warning/10 text-warning-foreground",
        className,
      )}
      role="alert"
      data-testid="inline-diagnostic"
      data-diagnostic={issues.map((d) => d.code).join(",")}
      data-source={[...new Set(issues.map((d) => d.source))].join(",")}
      data-hint={issues.map((d) => d.message).join("\n")}
    >
      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
        {issues.map((d, index) => (
          <span key={index} className="block">
            {d.source === "process" && <span className="font-mono">{d.code}: </span>}
            {d.message}
          </span>
        ))}
      </span>
    </span>
  );
}
