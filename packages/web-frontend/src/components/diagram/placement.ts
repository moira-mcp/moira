/**
 * The opening placement every diagram shares: once the substrate reports the viewport ready (after
 * its fit), the diagram places its own opening viewport — the first block, the current lane — and
 * places again only when the thing it follows changes, never on a plain refetch, so the reader's
 * own panning survives polling.
 *
 * `placed` is true once the placement for the current key has finished moving the camera (a
 * placement may be animated, or wait for React Flow to measure the nodes before it can fit them),
 * and false from the moment the key changes until then. A placement is also over when a camera
 * move that began after it stops — the reader's pan cuts an animated placement short, and a
 * cut-short animation never reports its own arrival — so the diagram hands its viewport's
 * `onMoveStart` and `onMoveEnd` to the hook. A diagram publishes it, with what else
 * decides whether its view is final, as `data-diagram-settled` on its viewport: the camera a
 * reader meets once the page has finished opening.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";

export function useOpeningPlacement<N extends Node, E extends Edge, K>(
  place: (instance: ReactFlowInstance<N, E>, key: K) => void | Promise<unknown>,
  key: K,
): {
  instance: ReactFlowInstance<N, E> | null;
  onInit: (instance: ReactFlowInstance<N, E>) => void;
  onReady: (instance: ReactFlowInstance<N, E>) => void;
  onMoveStart: () => void;
  onMoveEnd: () => void;
  placed: boolean;
} {
  const [instance, setInstance] = useState<ReactFlowInstance<N, E> | null>(null);
  // The key to place, and the placement to run, when the viewport reports ready. The substrate
  // calls back with the `onReady` it held when React Flow initialised, and both may have moved on
  // since (a second layout pass finishing before the opening fit): the placement follows the key
  // and the layout as they are now.
  const keyRef = useRef(key);
  keyRef.current = key;
  const placeRef = useRef(place);
  placeRef.current = place;
  // `undefined` until the first placement: a key change before the viewport is ready is placed by
  // `onReady`, not by the effect.
  const placedFor = useRef<K | undefined>(undefined);
  // The key whose placement has finished, compared with the current key. A placement that
  // finishes after a newer one has started reports nothing: the newer one decides.
  const [finished, setFinished] = useState<{ key: K } | null>(null);
  // A camera move began after the pending placement did: its end closes the placement. A move that
  // began earlier — the opening fit, whose end is reported late — does not.
  const movedSincePlacing = useRef(false);
  const run = useCallback((target: ReactFlowInstance<N, E>, placeKey: K) => {
    placedFor.current = placeKey;
    movedSincePlacing.current = false;
    setFinished(null);
    void Promise.resolve(placeRef.current(target, placeKey)).then(() => {
      if (placedFor.current === placeKey) setFinished({ key: placeKey });
    });
  }, []);
  useEffect(() => {
    if (!instance || placedFor.current === undefined || placedFor.current === key) return;
    run(instance, key);
  }, [instance, key, run]);
  const onReady = useCallback(
    (ready: ReactFlowInstance<N, E>) => run(ready, keyRef.current),
    [run],
  );
  const onMoveStart = useCallback(() => {
    if (placedFor.current !== undefined) movedSincePlacing.current = true;
  }, []);
  const onMoveEnd = useCallback(() => {
    const pending = placedFor.current;
    if (pending === undefined || !movedSincePlacing.current) return;
    setFinished((current) => (current && current.key === pending ? current : { key: pending }));
  }, []);
  return {
    instance,
    onInit: setInstance,
    onReady,
    onMoveStart,
    onMoveEnd,
    placed: finished !== null && finished.key === key,
  };
}
