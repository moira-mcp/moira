/**
 * Authoring edits — changes to the workflow definition, held in memory until saved.
 *
 * The edit set covers the process definition (block names and descriptions), the transitions
 * (connection labels with a loop's cause and exit), which block a node belongs to, a node's
 * authored content (directive, completion condition, message, expressions) and the variable
 * registry. `applyEdits` produces the edited definition the page re-derives and finally saves;
 * `exportDiff` lists exactly the flow-file entries the edits change. Nothing here touches a run.
 */

import React, { createContext, useContext, useMemo, useState } from "react";
import type { ProcessDiagnostic } from "@mcp-moira/workflow-engine/process";
import type {
  ConnectionLabel,
  RegistryVariable,
  WorkflowGraph,
  WorkflowNode,
} from "../../types/workflow-types";

/** Node fields the page edits in place. */
export type NodeTextField = "directive" | "completionCondition" | "message" | "expressions";

export interface FlowEdits {
  blocks: Record<string, { label?: string; summary?: string }>;
  /** Keyed by "node.key". */
  labels: Record<string, ConnectionLabel>;
  /** nodeId → blockId */
  ownership: Record<string, string>;
  /** nodeId → field patches; `expressions` is a string array. */
  nodes: Record<string, Partial<Record<NodeTextField, string | string[]>>>;
  /** name → replaced entry, or null for a removed declaration. */
  registry: Record<string, RegistryVariable | null>;
}

export const EMPTY_EDITS: FlowEdits = {
  blocks: {},
  labels: {},
  ownership: {},
  nodes: {},
  registry: {},
};

export function countEdits(edits: FlowEdits): number {
  return (
    Object.keys(edits.blocks).length +
    Object.keys(edits.labels).length +
    Object.keys(edits.ownership).length +
    Object.values(edits.nodes).reduce((n, patch) => n + Object.keys(patch).length, 0) +
    Object.keys(edits.registry).length
  );
}

/** The definition with the edits applied; the input is not mutated. */
export function applyEdits(workflow: WorkflowGraph, edits: FlowEdits): WorkflowGraph {
  if (countEdits(edits) === 0) return workflow;
  const progress = workflow.progress
    ? {
        ...workflow.progress,
        nodes: workflow.progress.nodes.map((block) => {
          const patch = edits.blocks[block.id];
          if (!patch) return block;
          return {
            ...block,
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.summary !== undefined
              ? { content: { ...(block.content ?? {}), summary: patch.summary } }
              : {}),
          };
        }),
      }
    : workflow.progress;
  const nodes = workflow.nodes.map((node) => {
    const labels = Object.fromEntries(
      Object.entries(edits.labels)
        .filter(([key]) => key.startsWith(`${node.id}.`))
        .map(([key, value]) => [key.slice(node.id.length + 1), value]),
    );
    const owner = edits.ownership[node.id];
    const fields = edits.nodes[node.id];
    if (!Object.keys(labels).length && owner === undefined && !fields) return node;
    return {
      ...node,
      ...(owner !== undefined ? { progressNodeId: owner } : {}),
      ...(Object.keys(labels).length
        ? { connectionLabels: { ...(node.connectionLabels ?? {}), ...labels } }
        : {}),
      ...(fields ?? {}),
    } as WorkflowNode;
  });
  let variableRegistry = workflow.variableRegistry;
  if (Object.keys(edits.registry).length) {
    variableRegistry = { ...(workflow.variableRegistry ?? {}) };
    for (const [name, entry] of Object.entries(edits.registry)) {
      if (entry === null) delete variableRegistry[name];
      else variableRegistry[name] = entry;
    }
  }
  return { ...workflow, progress, nodes, variableRegistry };
}

export interface ExportEntry {
  /** JSON path in the flow file. */
  path: string;
  before: unknown;
  after: unknown;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The flow-file entries the edit set changes, as path / before / after. No-op edits are omitted. */
export function exportDiff(workflow: WorkflowGraph, edits: FlowEdits): ExportEntry[] {
  const out: ExportEntry[] = [];
  const blocks = workflow.progress?.nodes ?? [];
  for (const [id, patch] of Object.entries(edits.blocks)) {
    const index = blocks.findIndex((b) => b.id === id);
    const block = blocks[index];
    if (!block) continue;
    if (patch.label !== undefined && patch.label !== block.label)
      out.push({ path: `progress.nodes[${index}].label`, before: block.label, after: patch.label });
    if (patch.summary !== undefined && patch.summary !== (block.content?.summary ?? ""))
      out.push({
        path: `progress.nodes[${index}].content.summary`,
        before: block.content?.summary,
        after: patch.summary,
      });
  }
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  for (const [edge, value] of Object.entries(edits.labels)) {
    const dot = edge.indexOf(".");
    const nodeId = edge.slice(0, dot);
    const key = edge.slice(dot + 1);
    const before = byId.get(nodeId)?.connectionLabels?.[key];
    if (!same(before, value))
      out.push({ path: `nodes[${nodeId}].connectionLabels.${key}`, before, after: value });
  }
  for (const [nodeId, blockId] of Object.entries(edits.ownership)) {
    const before = byId.get(nodeId)?.progressNodeId;
    if (before !== blockId)
      out.push({ path: `nodes[${nodeId}].progressNodeId`, before, after: blockId });
  }
  for (const [nodeId, fields] of Object.entries(edits.nodes)) {
    const node = byId.get(nodeId) as unknown as Record<string, unknown> | undefined;
    if (!node) continue;
    for (const [field, after] of Object.entries(fields)) {
      const before = node[field];
      if (!same(before, after)) out.push({ path: `nodes[${nodeId}].${field}`, before, after });
    }
  }
  for (const [name, entry] of Object.entries(edits.registry)) {
    const before = workflow.variableRegistry?.[name];
    const after = entry ?? undefined;
    if (!same(before, after)) out.push({ path: `variableRegistry.${name}`, before, after });
  }
  return out;
}

interface EditingContextValue {
  enabled: boolean;
  /** The page shows a definition with no run: the modes hide run status and read definition notes. */
  definition: boolean;
  edits: FlowEdits;
  /** The current derivation's diagnostics, shown inline on the offending block, step or edge. */
  diagnostics: ProcessDiagnostic[];
  setBlock: (blockId: string, patch: { label?: string; summary?: string }) => void;
  setLabel: (edgeIds: string[], value: ConnectionLabel) => void;
  setOwner: (nodeId: string, blockId: string) => void;
  setNodeField: (nodeId: string, field: NodeTextField, value: string | string[]) => void;
  setRegistry: (name: string, entry: RegistryVariable | null) => void;
  reset: () => void;
}

const EditingContext = createContext<EditingContextValue>({
  enabled: false,
  definition: false,
  edits: EMPTY_EDITS,
  diagnostics: [],
  setBlock: () => {},
  setLabel: () => {},
  setOwner: () => {},
  setNodeField: () => {},
  setRegistry: () => {},
  reset: () => {},
});

export function useEditing(): EditingContextValue {
  return useContext(EditingContext);
}

/** Diagnostics that point at a block, at a step, or at one of a step's edges. */
export function diagnosticsFor(
  diagnostics: readonly ProcessDiagnostic[],
  target: { blockId?: string; nodeId?: string },
): ProcessDiagnostic[] {
  return diagnostics.filter((d) =>
    target.nodeId !== undefined
      ? d.nodeId === target.nodeId || (d.edge?.startsWith(`${target.nodeId}.`) ?? false)
      : d.blockId === target.blockId && d.nodeId === undefined && d.edge === undefined,
  );
}

/** i18n prefix of the mode notes: the definition's on the flow page, the run's on the run page. */
export function useModeGuideKey(): string {
  return useContext(EditingContext).definition
    ? "pages.flowPage.modeGuide"
    : "pages.runPage.modeGuide";
}

export function EditingProvider({
  enabled,
  definition = true,
  edits,
  diagnostics = [],
  onChange,
  children,
}: {
  enabled: boolean;
  definition?: boolean;
  edits: FlowEdits;
  diagnostics?: ProcessDiagnostic[];
  onChange: (next: FlowEdits) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo<EditingContextValue>(
    () => ({
      enabled,
      definition,
      edits,
      diagnostics,
      setBlock: (blockId, patch) =>
        onChange({
          ...edits,
          blocks: { ...edits.blocks, [blockId]: { ...edits.blocks[blockId], ...patch } },
        }),
      setLabel: (edgeIds, label) =>
        onChange({
          ...edits,
          labels: { ...edits.labels, ...Object.fromEntries(edgeIds.map((e) => [e, label])) },
        }),
      setOwner: (nodeId, blockId) =>
        onChange({ ...edits, ownership: { ...edits.ownership, [nodeId]: blockId } }),
      setNodeField: (nodeId, field, fieldValue) =>
        onChange({
          ...edits,
          nodes: { ...edits.nodes, [nodeId]: { ...edits.nodes[nodeId], [field]: fieldValue } },
        }),
      setRegistry: (name, entry) =>
        onChange({ ...edits, registry: { ...edits.registry, [name]: entry } }),
      reset: () => onChange(EMPTY_EDITS),
    }),
    [enabled, definition, edits, diagnostics, onChange],
  );
  return <EditingContext.Provider value={value}>{children}</EditingContext.Provider>;
}

/** Local state helper for the page: edits live in memory until saved or discarded. */
export function useFlowEdits(): [FlowEdits, (next: FlowEdits) => void] {
  return useState<FlowEdits>(EMPTY_EDITS);
}
