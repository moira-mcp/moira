/**
 * Keeps React Flow's measurements across the diagrams' node rebuilds.
 *
 * React Flow stores a node's measured size — and with it the handle positions the edges are drawn
 * between — on the node object it was given. The diagrams are controlled without keeping their
 * nodes in state and rebuild the node objects whenever what a card shows changes (a selection, a
 * walkthrough step, an arrival pulse), so each rebuilt object arrives unmeasured: React Flow drops
 * the measurement and waits for its ResizeObserver to report the card again. Its node wrapper
 * re-arms that observer only when the node's "initialized" state flips, so a rebuild that lands
 * after the observer has reported but before React has rendered the report leaves the flag where
 * it was: the observer is never re-armed, and the card's size never changes again to wake it. The
 * diagram then stays unmeasured for good — edges lose their handles, the steps of a group are
 * clamped against a zero-size frame, and every `fitView` (the walkthrough's reveal, a port's
 * travel) stays queued behind a measurement that never comes. The window is a frame wide, so it
 * opens on a slow or busy machine.
 *
 * Carrying each node's last measured size onto the objects handed to React Flow — what
 * `applyNodeChanges` does for a flow that keeps its nodes in state — means a rebuild no longer
 * resets anything: the observer stays armed and still reports a card whose size really changes.
 * A node that declares `measured` itself (a frame whose size the layout fixes) keeps its own.
 */
import { useCallback, useMemo, useRef } from "react";
import type { Node, NodeChange } from "@xyflow/react";

type MeasuredSize = { width: number; height: number };

export function useMeasuredNodes<N extends Node>(
  nodes: N[] | undefined,
  onNodesChange: ((changes: NodeChange<N>[]) => void) | undefined,
): { nodes: N[] | undefined; onNodesChange: (changes: NodeChange<N>[]) => void } {
  const measuredRef = useRef(new Map<string, MeasuredSize>());
  const handleNodesChange = useCallback(
    (changes: NodeChange<N>[]) => {
      for (const change of changes) {
        if (change.type === "dimensions" && change.dimensions) {
          measuredRef.current.set(change.id, change.dimensions);
        } else if (change.type === "remove") {
          measuredRef.current.delete(change.id);
        }
      }
      onNodesChange?.(changes);
    },
    [onNodesChange],
  );
  const measuredNodes = useMemo(
    () =>
      nodes?.map((node) => {
        if (node.measured) return node;
        const measured = measuredRef.current.get(node.id);
        return measured ? { ...node, measured } : node;
      }),
    [nodes],
  );
  return { nodes: measuredNodes, onNodesChange: handleNodesChange };
}
