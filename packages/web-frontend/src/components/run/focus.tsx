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
import { ArrowRight, ArrowUpRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TransitionChip } from "./chips";

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

/**
 * A chip naming one connector's target inside its source block: `↩ target` for a return,
 * `↗ target` for a skip; the transition's label (and, for a return, its cause and exit) is the
 * tooltip and appears on the connector while the chip is hovered.
 */
export function TransitionChipView({
  chip,
  title,
  className,
}: {
  chip: TransitionChip;
  title: string;
  className?: string;
}): React.JSX.Element {
  const focus = useTransitionFocus();
  const lit = chip.keys.some((key) => isLit(focus, key, chip.from));
  const Icon =
    chip.kind === "return" ? RotateCcw : chip.kind === "forward" ? ArrowRight : ArrowUpRight;
  const hub = chip.kind === "hub";
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-1.5 py-0.5 text-[10px] font-medium leading-4",
        chip.kind === "return"
          ? "border-primary/40 text-primary"
          : "border-border text-muted-foreground",
        hub && "border-dashed",
        lit && (chip.kind === "return" ? "bg-primary/10" : "bg-accent"),
        className,
      )}
      title={title}
      onMouseEnter={() => focus.setHovered(chip.keys)}
      onMouseLeave={() => focus.setHovered(null)}
      data-transition={chip.key}
      data-connector-count={chip.keys.length > 1 ? chip.keys.length : undefined}
      data-return-chip={chip.kind === "return" ? chip.transition.to : undefined}
      data-skip-chip={chip.kind === "skip" ? chip.transition.to : undefined}
      data-exit-chip={hub ? chip.transition.to : undefined}
      data-forward-chip={chip.kind === "forward" ? chip.transition.to : undefined}
      data-arc={chip.kind === "return" ? "chip" : undefined}
      data-link={chip.kind === "skip" ? "chip" : undefined}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">{chip.targetNumber}</span>
      <span className="truncate">{chip.targetName}</span>
      {chip.labels.length > 1 && (
        <span className="tabular-nums opacity-70">×{chip.labels.length}</span>
      )}
    </span>
  );
}
