import { useState, useEffect, useCallback, useRef } from "react";

const DEFAULT_ROW_HEIGHT = 41; // DataTable row height in px
const DEFAULT_PAGE_SIZE = 20;
const MIN_ROWS = 5;
const MAX_PAGE_SIZE = 100;
const HEADER_OVERHEAD = 40; // table header height
const RESIZE_DEBOUNCE_MS = 500; // debounce resize events

export interface PageSizeOptions {
  /** Items in one row (a grid shows several side by side); read at every measurement. */
  perRow?: () => number;
  /** The fewest rows a page holds, however little room there is. */
  minRows?: number;
  /** Pixels above the first row that are not rows (a table header). */
  overhead?: number;
}

function calculatePageSize(height: number, rowHeight: number, options: PageSizeOptions) {
  if (height <= 0) return null;
  const available = height - (options.overhead ?? HEADER_OVERHEAD);
  const rows = Math.max(options.minRows ?? MIN_ROWS, Math.floor(available / rowHeight));
  return Math.min(MAX_PAGE_SIZE, rows * (options.perRow?.() ?? 1));
}

/**
 * Dynamically calculates page size based on available container height.
 * Returns a ref callback to attach to the scrollable container.
 * Debounces ResizeObserver events to prevent multiple API calls during layout settling.
 */
export function useDynamicPageSize(rowHeight = DEFAULT_ROW_HEIGHT, options: PageSizeOptions = {}) {
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  // The container as state: a list shows a loader first and mounts its container later, and the
  // observer must attach to whichever node is there now.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const measureAndSet = useCallback(() => {
    if (!container) return;
    const size = calculatePageSize(container.clientHeight, rowHeight, optionsRef.current);
    if (size !== null) setPageSize(size);
  }, [container, rowHeight]);

  // Measure on mount of the container and when the row height changes (a list switching between
  // its list and grid views)
  useEffect(() => {
    measureAndSet();
  }, [measureAndSet]);

  // ResizeObserver for window/container resize — debounced to avoid cascading updates
  useEffect(() => {
    if (!container) return;
    const observer = new ResizeObserver(() => {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => measureAndSet(), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
    return () => {
      clearTimeout(debounceTimer.current);
      observer.disconnect();
    };
  }, [container, measureAndSet]);

  return { pageSize, containerRef: setContainer };
}
