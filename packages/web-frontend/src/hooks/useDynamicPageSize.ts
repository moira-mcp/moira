import { useState, useEffect, useCallback, useRef } from "react";

const DEFAULT_ROW_HEIGHT = 41; // DataTable row height in px
const DEFAULT_PAGE_SIZE = 20;
const MIN_PAGE_SIZE = 5;
const MAX_PAGE_SIZE = 100;
const HEADER_OVERHEAD = 40; // table header height
const RESIZE_DEBOUNCE_MS = 500; // debounce resize events

function calculatePageSize(height: number, rowHeight: number) {
  if (height <= 0) return null;
  const available = height - HEADER_OVERHEAD;
  const calculated = Math.floor(available / rowHeight);
  return Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, calculated));
}

/**
 * Dynamically calculates page size based on available container height.
 * Returns a ref callback to attach to the scrollable container.
 * Debounces ResizeObserver events to prevent multiple API calls during layout settling.
 */
export function useDynamicPageSize(rowHeight = DEFAULT_ROW_HEIGHT) {
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>();

  const measureAndSet = useCallback(() => {
    if (!containerRef.current) return;
    const size = calculatePageSize(containerRef.current.clientHeight, rowHeight);
    if (size !== null) setPageSize(size);
  }, [rowHeight]);

  // Ref callback — measures immediately on mount
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      if (node) measureAndSet();
    },
    [measureAndSet],
  );

  // ResizeObserver for window/container resize — debounced to avoid cascading updates
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => measureAndSet(), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(containerRef.current);
    return () => {
      clearTimeout(debounceTimer.current);
      observer.disconnect();
    };
  }, [measureAndSet]);

  return { pageSize, containerRef: setRef };
}
