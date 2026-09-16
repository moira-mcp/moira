/**
 * The second level of the page's right panel: one step, reached from its block. A breadcrumb
 * names the block and the step, a back button returns to the block, and the body shows what the
 * step card keeps in tooltips — the full directive and completion condition, the returned fields,
 * the expressions, the routing cases and the connections — with every variable reference an
 * interactive token.
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronRight, Crosshair } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NodeTypeTag } from "./nodeTypeStyle";
import {
  ConditionText,
  ExpressionText,
  TemplateText,
  VariableProvider,
} from "../diagram/VariableText";
import type { VariableDefinition } from "../diagram/VariableText";
import type { WorkflowGraph } from "../../types/workflow-types";
import { blockById, nodeOwners, stepsOf, type RunBlock } from "./model";

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <section className="space-y-1" data-testid={testId}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </section>
  );
}

export function NodePanel({
  workflow,
  blocks,
  nodeId,
  onBack,
  onFocusNode,
  onSelectVariable,
}: {
  workflow: WorkflowGraph;
  blocks: RunBlock[];
  nodeId: string;
  /** Back to the block level. */
  onBack: () => void;
  /** Bring the step into view on the graph. */
  onFocusNode?: (nodeId: string) => void;
  /** Jump to a variable's definition (the variables tab). */
  onSelectVariable?: (name: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const step = useMemo(() => stepsOf(workflow, [nodeId])[0], [workflow, nodeId]);
  const owners = useMemo(() => nodeOwners(blocks), [blocks]);
  const owner = blockById(blocks).get(owners.get(nodeId) ?? "") ?? null;
  const node = workflow.nodes.find((n) => n.id === nodeId) as unknown as
    (Record<string, unknown> & { connections?: Record<string, string> }) | undefined;
  const nameOf = (id: string) => {
    const target = workflow.nodes.find((n) => n.id === id);
    const label = (target as { progressActiveLabel?: string } | undefined)?.progressActiveLabel;
    return label ?? target?.metadata?.displayName ?? id;
  };
  return (
    <VariableProvider
      value={{
        registry: (workflow.variableRegistry ?? {}) as Record<string, VariableDefinition>,
        onSelect: onSelectVariable,
      }}
    >
      <div className="space-y-4 p-4" data-testid="node-panel" data-node-id={nodeId}>
        <nav
          className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          aria-label="breadcrumb"
          data-testid="node-panel-breadcrumb"
        >
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground"
            data-testid="node-panel-back"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {owner ? `${owner.index + 1}. ${owner.name}` : t("pages.runPage.map.contents")}
          </button>
          <ChevronRight className="size-3" aria-hidden="true" />
          <span className="font-mono text-foreground">{nodeId}</span>
        </nav>

        <div className="flex items-start gap-3">
          <NodeTypeTag type={step.type} />
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-tight">
              <TemplateText text={step.progressLabel ?? step.displayName ?? step.id} compact />
            </h3>
            {step.progressContent && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                <TemplateText text={step.progressContent} />
              </p>
            )}
          </div>
          {onFocusNode && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => onFocusNode(nodeId)}
              data-testid="node-panel-focus"
            >
              <Crosshair className="size-3.5" aria-hidden="true" />
              {t("pages.runPage.map.showOnGraph", { defaultValue: "На графе" })}
            </Button>
          )}
        </div>

        {step.text && (
          <Section title={step.routing ? "message" : "directive"} testId="node-panel-directive">
            <p className="whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere]">
              <TemplateText text={step.text} />
            </p>
          </Section>
        )}
        {step.completionCondition && (
          <Section title="completion">
            <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
              <TemplateText text={step.completionCondition} />
            </p>
          </Section>
        )}
        {step.evidence.length > 0 && (
          <Section title={t("pages.runPage.blockDetail.returns")} testId="node-panel-returns">
            <ul className="space-y-1 text-xs">
              {step.evidence.map((field) => (
                <li key={field.name} className="flex flex-wrap items-baseline gap-x-2">
                  <code className="rounded border bg-background px-1 font-mono text-[11px]">
                    {field.name}
                    {field.type && <span className="text-muted-foreground">: {field.type}</span>}
                  </code>
                  {field.required && (
                    <span className="text-[10px] uppercase text-muted-foreground">required</span>
                  )}
                  {field.description && (
                    <span className="text-muted-foreground">{field.description}</span>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}
        {step.expressions.length > 0 && (
          <Section title="expressions" testId="node-panel-expressions">
            <ul className="space-y-0.5 font-mono text-[11px]">
              {step.expressions.map((expression, index) => (
                <li key={index}>
                  <ExpressionText text={expression} />
                </li>
              ))}
            </ul>
          </Section>
        )}
        {step.cases.length > 0 && (
          <Section title="cases" testId="node-panel-cases">
            <ol className="space-y-1 text-[11px]">
              {step.cases.map((c, index) => (
                <li key={index} className="flex flex-wrap items-center gap-1 font-mono">
                  <ConditionText when={c.when} />
                  <span className="text-muted-foreground">→</span>
                  <span className="rounded border px-1">{c.output}</span>
                  {node?.connections?.[c.output] && (
                    <span className="text-muted-foreground">
                      → {nameOf(node.connections[c.output])}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Section>
        )}
        {node?.connections && Object.keys(node.connections).length > 0 && (
          <Section title="connections" testId="node-panel-connections">
            <ul className="space-y-0.5 text-[11px]">
              {Object.entries(node.connections).map(([key, target]) => (
                <li key={key} className="flex items-center gap-1 font-mono">
                  <span className="rounded border px-1">{key}</span>
                  <span className="text-muted-foreground">→</span>
                  <button
                    type="button"
                    className="truncate text-left hover:underline"
                    onClick={() => onFocusNode?.(target)}
                  >
                    {nameOf(target)}
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </VariableProvider>
  );
}
