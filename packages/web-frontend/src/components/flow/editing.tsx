/**
 * Authoring on the flow page — the edit log's state and the context the views edit through.
 *
 * `useEditLog` holds the operations over the saved definition (see `operations.ts`) and folds them
 * into the draft the page re-derives, validates and finally saves; undo drops the last operation,
 * reset drops them all. The views never see the log: they read the draft and call the context's
 * setters, each of which appends one operation. The context also carries where every current
 * problem sits (`issues.ts`), so a block, a step or an edge can show its own. Nothing here touches
 * a run.
 */

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ConnectionLabel, RegistryVariable, WorkflowGraph } from "../../types/workflow-types";
import { NO_ISSUES, type IssuePlacement } from "./issues";
import { appendOperation, foldOperations, type NodeTextField, type Operation } from "./operations";

export type { NodeTextField } from "./operations";

interface EditingContextValue {
  enabled: boolean;
  /** The page shows a definition with no run: the modes hide run status and read definition notes. */
  definition: boolean;
  /** Where the current problems sit: shown inline on the offending block, step or edge. */
  issues: IssuePlacement;
  setBlock: (blockId: string, patch: { label?: string; summary?: string }) => void;
  setLabel: (edgeIds: string[], value: ConnectionLabel) => void;
  setOwner: (nodeId: string, blockId: string) => void;
  setNodeField: (nodeId: string, field: NodeTextField, value: string | string[]) => void;
  setRegistry: (name: string, entry: RegistryVariable | null) => void;
  /** Append any operation; a refused structural operation throws its `AuthoringError`. */
  apply: (op: Operation) => void;
}

const EditingContext = createContext<EditingContextValue>({
  enabled: false,
  definition: false,
  issues: NO_ISSUES,
  setBlock: () => {},
  setLabel: () => {},
  setOwner: () => {},
  setNodeField: () => {},
  setRegistry: () => {},
  apply: () => {},
});

export function useEditing(): EditingContextValue {
  return useContext(EditingContext);
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
  issues = NO_ISSUES,
  apply,
  children,
}: {
  enabled: boolean;
  definition?: boolean;
  issues?: IssuePlacement;
  apply: (op: Operation) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo<EditingContextValue>(
    () => ({
      enabled,
      definition,
      issues,
      apply,
      setBlock: (blockId, patch) => {
        if (patch.label !== undefined)
          apply({ kind: "block-text", blockId, field: "label", value: patch.label });
        if (patch.summary !== undefined)
          apply({ kind: "block-text", blockId, field: "summary", value: patch.summary });
      },
      setLabel: (edges, label) => apply({ kind: "connection-label", edges, value: label }),
      setOwner: (nodeId, blockId) => apply({ kind: "node-block", nodeId, blockId }),
      setNodeField: (nodeId, field, fieldValue) =>
        apply({ kind: "node-text", nodeId, field, value: fieldValue }),
      setRegistry: (name, entry) => apply({ kind: "registry", name, entry }),
    }),
    [enabled, definition, issues, apply],
  );
  return <EditingContext.Provider value={value}>{children}</EditingContext.Provider>;
}

/**
 * The page's edit log over `saved`: the operations, the draft they fold into, and the actions.
 * `apply` appends (or merges a keystroke into the last operation) and throws a refused structural
 * operation's `AuthoringError` without changing the log.
 */
export function useEditLog(saved: WorkflowGraph | undefined): {
  ops: readonly Operation[];
  draft: WorkflowGraph | undefined;
  apply: (op: Operation) => void;
  undo: () => void;
  reset: () => void;
} {
  const [ops, setOps] = useState<Operation[]>([]);
  const draft = useMemo(() => (saved ? foldOperations(saved, ops) : undefined), [saved, ops]);
  // Two operations can arrive before the page renders again (a block's name and description in
  // one call): each is appended to the log as the previous one left it, not as the last render saw.
  const latest = useRef({ saved, ops });
  latest.current = { saved, ops };
  const apply = useCallback((op: Operation) => {
    const { saved: base, ops: log } = latest.current;
    if (!base) return;
    const next = appendOperation(foldOperations(base, log), log, op);
    latest.current = { saved: base, ops: next };
    setOps(next);
  }, []);
  const undo = useCallback(() => setOps((current) => current.slice(0, -1)), []);
  const reset = useCallback(() => setOps([]), []);
  return { ops, draft, apply, undo, reset };
}
