/**
 * Authoring edits — changes to the flow definition, held in memory.
 *
 * This is the authoring side of the prototype and is deliberately separate from anything about a
 * run: it edits what the process *is* (block names and descriptions, transition labels and cycle
 * explanations, which block a node belongs to), never what a run did. Edits are applied to the
 * annotated workflow before derivation, so every view and the diagnostics react at once, and the
 * export shows exactly the flow-file entries the edits would change. Nothing is persisted: reload
 * discards everything.
 */

import React, { createContext, useContext, useMemo, useState } from "react";
import type { AnnotatedWorkflow, AuthoredNode, ConnectionLabel } from "./model";

export interface FlowEdits {
  blocks: Record<string, { label?: string; summary?: string }>;
  /** Keyed by "node.key". */
  labels: Record<string, ConnectionLabel>;
  /** nodeId → blockId */
  ownership: Record<string, string>;
}

export const EMPTY_EDITS: FlowEdits = { blocks: {}, labels: {}, ownership: {} };

export function countEdits(edits: FlowEdits): number {
  return (
    Object.keys(edits.blocks).length +
    Object.keys(edits.labels).length +
    Object.keys(edits.ownership).length
  );
}

/** The annotated workflow and its nodes with the edits applied; inputs are not mutated. */
export function applyEdits(
  workflow: AnnotatedWorkflow,
  authored: AuthoredNode[],
  edits: FlowEdits,
): { workflow: AnnotatedWorkflow; authored: AuthoredNode[] } {
  if (countEdits(edits) === 0) return { workflow, authored };
  return {
    workflow: {
      ...workflow,
      blocks: workflow.blocks.map((b) => ({ ...b, ...edits.blocks[b.id] })),
    },
    authored: authored.map((n) => {
      const labels = Object.fromEntries(
        Object.entries(edits.labels)
          .filter(([k]) => k.startsWith(`${n.id}.`))
          .map(([k, v]) => [k.slice(n.id.length + 1), v]),
      );
      const owner = edits.ownership[n.id];
      if (!Object.keys(labels).length && owner === undefined) return n;
      return {
        ...n,
        ...(owner !== undefined ? { progressNodeId: owner } : {}),
        ...(Object.keys(labels).length
          ? { connectionLabels: { ...(n.connectionLabels ?? {}), ...labels } }
          : {}),
      };
    }),
  };
}

export interface ExportEntry {
  /** JSON path in the flow file. */
  path: string;
  before: unknown;
  after: unknown;
}

/** The flow-file entries an edit set would change, as path/before/after. */
export function exportDiff(
  workflow: AnnotatedWorkflow,
  authored: AuthoredNode[],
  edits: FlowEdits,
): ExportEntry[] {
  const out: ExportEntry[] = [];
  for (const [id, patch] of Object.entries(edits.blocks)) {
    const index = workflow.blocks.findIndex((b) => b.id === id);
    const block = workflow.blocks[index];
    if (!block) continue;
    if (patch.label !== undefined && patch.label !== block.label)
      out.push({ path: `progress.nodes[${index}].label`, before: block.label, after: patch.label });
    if (patch.summary !== undefined && patch.summary !== block.summary)
      out.push({
        path: `progress.nodes[${index}].content.summary`,
        before: block.summary,
        after: patch.summary,
      });
  }
  const byId = new Map(authored.map((n) => [n.id, n]));
  for (const [edge, value] of Object.entries(edits.labels)) {
    const dot = edge.indexOf(".");
    const nodeId = edge.slice(0, dot);
    const key = edge.slice(dot + 1);
    const before = byId.get(nodeId)?.connectionLabels?.[key];
    if (JSON.stringify(before) !== JSON.stringify(value))
      out.push({ path: `nodes[${nodeId}].connectionLabels.${key}`, before, after: value });
  }
  for (const [nodeId, blockId] of Object.entries(edits.ownership)) {
    const before = byId.get(nodeId)?.progressNodeId;
    if (before !== blockId)
      out.push({ path: `nodes[${nodeId}].progressNodeId`, before, after: blockId });
  }
  return out;
}

interface EditingContextValue {
  enabled: boolean;
  edits: FlowEdits;
  setBlock: (blockId: string, patch: { label?: string; summary?: string }) => void;
  setLabel: (edgeIds: string[], value: ConnectionLabel) => void;
  setOwner: (nodeId: string, blockId: string) => void;
  reset: () => void;
}

const EditingContext = createContext<EditingContextValue>({
  enabled: false,
  edits: EMPTY_EDITS,
  setBlock: () => {},
  setLabel: () => {},
  setOwner: () => {},
  reset: () => {},
});

export function useEditing(): EditingContextValue {
  return useContext(EditingContext);
}

export function EditingProvider({
  enabled,
  edits,
  onChange,
  children,
}: {
  enabled: boolean;
  edits: FlowEdits;
  onChange: (next: FlowEdits) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo<EditingContextValue>(
    () => ({
      enabled,
      edits,
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
      reset: () => onChange(EMPTY_EDITS),
    }),
    [enabled, edits, onChange],
  );
  return <EditingContext.Provider value={value}>{children}</EditingContext.Provider>;
}

/** Local state helper for the host: edits live in memory for the page's lifetime only. */
export function useFlowEdits(): [FlowEdits, (next: FlowEdits) => void] {
  return useState<FlowEdits>(EMPTY_EDITS);
}
