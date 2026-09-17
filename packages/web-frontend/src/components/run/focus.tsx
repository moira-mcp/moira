/**
 * Which connector is lit. Connectors (return arcs, skip links, cycle and skip edges) are thin and
 * muted at rest and carry no label; a chip in the source block names each one. Hovering a chip or
 * a connector lights that one transition and shows its label; a block the reader selected lights
 * all of its connectors while nothing is hovered, which is the keyboard and touch path. The block
 * a run is at is shown by default but not pinned, so a page opens with no label at rest.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface TransitionFocus {
  /** The keys of the hovered chip's connectors (or the one hovered connector), or null. */
  hovered: ReadonlySet<string> | null;
  setHovered: (keys: readonly string[] | null) => void;
  /** The block the reader selected: its transitions are lit while nothing is hovered. */
  pinnedBlock: string | null;
  /** The connectors the reader just travelled along: lit and pulsing for a moment. */
  flashed: ReadonlySet<string> | null;
  flash: (keys: readonly string[]) => void;
}

const FocusContext = createContext<TransitionFocus>({
  hovered: null,
  setHovered: () => {},
  pinnedBlock: null,
  flashed: null,
  flash: () => {},
});

const FLASH_MS = 1800;

export function TransitionFocusProvider({
  pinnedBlock,
  children,
}: {
  pinnedBlock: string | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const [hovered, setHoveredState] = useState<ReadonlySet<string> | null>(null);
  const setHovered = useCallback(
    (keys: readonly string[] | null) => setHoveredState(keys ? new Set(keys) : null),
    [],
  );
  const [flashed, setFlashed] = useState<ReadonlySet<string> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((keys: readonly string[]) => {
    setFlashed(new Set(keys));
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashed(null), FLASH_MS);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  const value = useMemo(
    () => ({ hovered, setHovered, pinnedBlock, flashed, flash }),
    [hovered, setHovered, pinnedBlock, flashed, flash],
  );
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export function useTransitionFocus(): TransitionFocus {
  return useContext(FocusContext);
}

export type TransitionFocusHandle = Pick<TransitionFocus, "flash" | "setHovered">;

/**
 * Hands the store to a component that mounts the provider itself and needs to flash a connector
 * from outside it (the graph's `goTo`).
 */
export function FocusBridge({
  handle,
}: {
  handle: React.MutableRefObject<TransitionFocusHandle | null>;
}): null {
  const focus = useTransitionFocus();
  useEffect(() => {
    handle.current = { flash: focus.flash, setHovered: focus.setHovered };
  }, [handle, focus.flash, focus.setHovered]);
  return null;
}

/** Whether the connector `key` from block `from` is lit under the current focus. */
export function isLit(focus: TransitionFocus, key: string, from: string): boolean {
  return focus.hovered ? focus.hovered.has(key) : focus.pinnedBlock === from;
}

/** Whether the connector `key` was just travelled along. */
export function isFlashed(focus: TransitionFocus, key: string): boolean {
  return focus.flashed?.has(key) ?? false;
}
