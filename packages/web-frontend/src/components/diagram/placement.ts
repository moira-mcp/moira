/**
 * The opening placement every diagram shares: once the substrate reports the viewport ready (after
 * its fit), the diagram places its own opening viewport — the first block, the current lane — and
 * places again only when the thing it follows changes, never on a plain refetch, so the reader's
 * own panning survives polling.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";

export function useOpeningPlacement<N extends Node, E extends Edge, K>(
  place: (instance: ReactFlowInstance<N, E>, key: K) => void,
  key: K,
): {
  instance: ReactFlowInstance<N, E> | null;
  onInit: (instance: ReactFlowInstance<N, E>) => void;
  onReady: (instance: ReactFlowInstance<N, E>) => void;
} {
  const [instance, setInstance] = useState<ReactFlowInstance<N, E> | null>(null);
  // `undefined` until the first placement: a key change before the viewport is ready is placed by
  // `onReady`, not by the effect.
  const placedFor = useRef<K | undefined>(undefined);
  useEffect(() => {
    if (!instance || placedFor.current === undefined || placedFor.current === key) return;
    placedFor.current = key;
    place(instance, key);
  }, [instance, key, place]);
  const onReady = useCallback(
    (ready: ReactFlowInstance<N, E>) => {
      placedFor.current = key;
      place(ready, key);
    },
    [key, place],
  );
  return { instance, onInit: setInstance, onReady };
}
