/**
 * The steps of a block as a list: type tag, id or display name, the first sentence of the
 * directive, the evidence the step demands back (its input schema fields), and a marker on the
 * step the run is on. Shared by the outline mode and the block-detail panel.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { NodeTypeTag } from "./nodeTypeStyle";
import type { StepInfo } from "./model";

export function StepList({
  steps,
  currentNodeId,
  onFocusNode,
  className,
}: {
  steps: StepInfo[];
  currentNodeId: string | null;
  /** Focus the step on the technical node graph. */
  onFocusNode?: (nodeId: string) => void;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ol className={cn("divide-y rounded-lg border bg-card", className)} data-testid="step-list">
      {steps.map((step) => {
        const isCurrent = currentNodeId === step.id;
        const Row: "button" | "div" = onFocusNode ? "button" : "div";
        return (
          <li
            key={step.id}
            className={cn("text-sm", isCurrent && "bg-primary/5")}
            data-node-id={step.id}
            aria-current={isCurrent ? "step" : undefined}
          >
            <Row
              {...(onFocusNode
                ? { type: "button" as const, onClick: () => onFocusNode(step.id) }
                : {})}
              className={cn(
                "flex w-full items-start gap-3 px-3 py-2 text-left",
                onFocusNode &&
                  "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              title={onFocusNode ? t("pages.runPage.blockDetail.focusStep") : undefined}
            >
              <NodeTypeTag type={step.type} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs text-foreground">
                  {step.displayName ?? step.id}
                  {step.displayName && (
                    <span className="ml-1 text-muted-foreground">({step.id})</span>
                  )}
                </p>
                {step.summary && (
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{step.summary}</p>
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
                        {field.type && (
                          <span className="text-muted-foreground">: {field.type}</span>
                        )}
                      </span>
                    ))}
                  </p>
                )}
              </div>
              {isCurrent && (
                <span className="ml-auto shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                  {t("pages.runPage.blockDetail.current")}
                </span>
              )}
            </Row>
          </li>
        );
      })}
    </ol>
  );
}
