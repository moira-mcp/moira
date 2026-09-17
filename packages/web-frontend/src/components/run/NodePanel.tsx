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
import { PanelSection } from "../diagram/PanelSection";
import {
  ConditionText,
  ExpressionText,
  TemplateText,
  VariableProvider,
} from "../diagram/VariableText";
import type { VariableDefinition } from "../diagram/VariableText";
import type { WorkflowGraph } from "../../types/workflow-types";
import type { WorkflowValidationStatus } from "../../types/react-flow-types";
import type { NodeTypeIndex } from "../../types/node-type-catalog";
import { NodeSchemaReadout } from "../workflow/NodeSchemaReadout";
import { NodePlaybookReferences, collectNodeReferences } from "../workflow/NodePlaybookReferences";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { blockById, nodeOwners, stepsOf, type RunBlock } from "./model";

export function NodePanel({
  workflow,
  blocks,
  nodeId,
  onBack,
  onFocusNode,
  onSelectVariable,
  validation,
  nodeTypes,
}: {
  workflow: WorkflowGraph;
  blocks: RunBlock[];
  nodeId: string;
  /** The definition's validation status; the node's own errors and warnings are shown. */
  validation?: WorkflowValidationStatus | null;
  /** The node-type catalog Moira serves: a catalog-drawn node shows its configuration against it. */
  nodeTypes?: NodeTypeIndex;
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
  const described = nodeTypes?.[step.type];
  const node = workflow.nodes.find((n) => n.id === nodeId) as unknown as
    (Record<string, unknown> & { connections?: Record<string, string> }) | undefined;
  const nameOf = (id: string) => {
    const target = workflow.nodes.find((n) => n.id === id);
    const label = (target as { progressActiveLabel?: string } | undefined)?.progressActiveLabel;
    return label ?? target?.metadata?.displayName ?? id;
  };
  // What the flow page's node sidebar used to show and the panel now owns: the node's own
  // validation, the playbooks its texts name, a catalog-drawn node's configuration read against
  // the schema its type declares, the raw input schema, a subgraph id, a materialize declaration.
  const errors = validation?.nodeValidation?.[nodeId]?.errors ?? [];
  const warnings = validation?.nodeValidation?.[nodeId]?.warnings ?? [];
  const body = (node ?? {}) as Record<string, unknown>;
  const basePath = typeof body.basePath === "string" ? body.basePath : undefined;
  const filePaths = Array.isArray(body.filePaths)
    ? (body.filePaths as unknown[]).filter((f): f is string => typeof f === "string")
    : undefined;
  const playbookTexts = [
    step.text ?? undefined,
    step.completionCondition ?? undefined,
    basePath,
    ...(filePaths ?? []),
  ];
  const playbooks = collectNodeReferences(playbookTexts);
  const nodeConfig = described
    ? described.schemaScope === "node"
      ? body
      : ((body.config as Record<string, unknown> | undefined) ?? {})
    : undefined;
  const inputSchema = body.inputSchema as Record<string, unknown> | undefined;
  const graphId = typeof body.graphId === "string" ? body.graphId : undefined;
  return (
    <VariableProvider
      value={{
        registry: (workflow.variableRegistry ?? {}) as Record<string, VariableDefinition>,
        onSelect: onSelectVariable,
      }}
    >
      <div className="space-y-3 p-3" data-testid="node-panel" data-node-id={nodeId}>
        <nav
          className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          aria-label={t("components.nodePanel.breadcrumb")}
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
              <TemplateText
                text={step.progressLabel ?? step.displayName ?? described?.title ?? step.id}
                compact
              />
            </h3>
            {described && (
              <code
                className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground"
                data-testid="node-panel-type"
              >
                {step.type}
              </code>
            )}
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
              {t("components.nodePanel.showOnGraph")}
            </Button>
          )}
        </div>

        {(errors.length > 0 || warnings.length > 0) && (
          <PanelSection
            id="validation"
            title={t("components.workflowGraph.nodeDetails.validation")}
            summary={String(errors.length + warnings.length)}
            testId="node-panel-validation"
          >
            <ul className="space-y-1 text-xs">
              {errors.map((message, index) => (
                <li key={`e${index}`} className="flex items-start gap-2 text-destructive">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>{message}</span>
                </li>
              ))}
              {warnings.map((message, index) => (
                <li key={`w${index}`} className="flex items-start gap-2 text-warning-foreground">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>{message}</span>
                </li>
              ))}
            </ul>
          </PanelSection>
        )}
        {step.text && (
          <PanelSection
            id={step.routing ? "message" : "directive"}
            title={t(`components.nodePanel.sections.${step.routing ? "message" : "directive"}`)}
            testId="node-panel-directive"
          >
            <p className="whitespace-pre-wrap break-words text-xs leading-5 [overflow-wrap:anywhere]">
              <TemplateText text={step.text} />
            </p>
          </PanelSection>
        )}
        {step.completionCondition && (
          <PanelSection id="completion" title={t("components.nodePanel.sections.completion")}>
            <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
              <TemplateText text={step.completionCondition} />
            </p>
          </PanelSection>
        )}
        {step.evidence.length > 0 && (
          <PanelSection
            id="returns"
            title={t("components.nodePanel.sections.returns")}
            testId="node-panel-returns"
          >
            <ul className="space-y-1 text-xs">
              {step.evidence.map((field) => (
                <li key={field.name} className="flex flex-wrap items-baseline gap-x-2">
                  <code className="rounded border bg-background px-1 font-mono text-[11px]">
                    {field.name}
                    {field.type && <span className="text-muted-foreground">: {field.type}</span>}
                  </code>
                  {field.required && (
                    <span className="text-[10px] uppercase text-muted-foreground">
                      {t("components.nodePanel.required")}
                    </span>
                  )}
                  {field.description && (
                    <span className="text-muted-foreground">{field.description}</span>
                  )}
                </li>
              ))}
            </ul>
          </PanelSection>
        )}
        {step.expressions.length > 0 && (
          <PanelSection
            id="expressions"
            title={t("components.nodePanel.sections.expressions")}
            testId="node-panel-expressions"
          >
            <ul className="space-y-0.5 font-mono text-[11px]">
              {step.expressions.map((expression, index) => (
                <li key={index}>
                  <ExpressionText text={expression} />
                </li>
              ))}
            </ul>
          </PanelSection>
        )}
        {step.cases.length > 0 && (
          <PanelSection
            id="cases"
            title={t("components.nodePanel.sections.cases")}
            testId="node-panel-cases"
          >
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
          </PanelSection>
        )}
        {playbooks.length > 0 && (
          <PanelSection
            id="playbooks"
            title={t("components.workflowGraph.nodeDetails.playbooks")}
            summary={String(playbooks.length)}
            testId="node-panel-playbooks"
          >
            <NodePlaybookReferences texts={playbookTexts} />
          </PanelSection>
        )}
        {described && nodeConfig !== undefined && (
          <PanelSection
            id="configuration"
            title={t("components.workflowSidebar.configuration")}
            summary={
              described.extensionName
                ? `${t("components.workflowSidebar.providedBy")} ${described.extensionName}${described.extensionVersion ? ` ${described.extensionVersion}` : ""}`
                : undefined
            }
            testId="node-panel-configuration"
          >
            <NodeSchemaReadout schema={described.schema ?? null} value={nodeConfig} />
          </PanelSection>
        )}
        {graphId && (
          <PanelSection
            id="subgraph"
            title={t("components.workflowGraph.nodeDetails.subgraphId")}
            testId="node-panel-subgraph"
          >
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{graphId}</code>
          </PanelSection>
        )}
        {basePath && filePaths && (
          <PanelSection
            id="materialize"
            title={t("components.nodePanel.sections.materialize")}
            summary={String(filePaths.length)}
            testId="node-panel-materialize"
          >
            <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
              {basePath}
            </code>
            <ul className="mt-1 space-y-0.5">
              {filePaths.map((path) => (
                <li key={path} className="break-all font-mono text-xs">
                  {path}
                </li>
              ))}
            </ul>
          </PanelSection>
        )}
        {inputSchema && Object.keys(inputSchema).length > 0 && (
          <PanelSection
            id="input-schema"
            title={t("components.workflowGraph.nodeDetails.inputSchema")}
            defaultOpen={false}
            testId="node-panel-input-schema"
          >
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-[11px]">
              {JSON.stringify(inputSchema, null, 2)}
            </pre>
          </PanelSection>
        )}
        {node?.connections && Object.keys(node.connections).length > 0 && (
          <PanelSection
            id="connections"
            title={t("components.nodePanel.sections.connections")}
            testId="node-panel-connections"
          >
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
          </PanelSection>
        )}
      </div>
    </VariableProvider>
  );
}
