/**
 * The page size of a list page drawn with DataListView and CardShell items: as many items as fit
 * the list's box in the view the reader chose — rows of list items, or rows of grid cards times the
 * columns the grid shows at this width. It starts from the typical item height and, the first time
 * a view draws its items, measures the real one (items without a description are shorter), so a
 * page holds the items that fit instead of leaving an empty band or cutting one off. That
 * measurement is taken once per view: the items of a later page never change the size, so paging
 * stays where the reader went and the size cannot swing between two values. When the size changes —
 * a view switch, a resize of the box, that first measurement — the page is told so it can go back
 * to its first page instead of skipping items.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewMode } from "@/components/DataListView";
import { GRID_ROW_HEIGHT, LIST_ITEM_HEIGHT } from "@/components/cards/CardShell";
import { useDynamicPageSize } from "./useDynamicPageSize";

/** The gap below a list item and between grid rows, as CardShell and DataListView draw them. */
const LIST_GAP = 8;
const GRID_GAP = 12;

/** The grid's columns at this viewport width, as DataListView's grid lays them out. */
function gridColumns(): number {
  const width = typeof window === "undefined" ? 1024 : window.innerWidth;
  if (width >= 1024) return 3;
  if (width >= 640) return 2;
  return 1;
}

export function useListPageSize(onPageSizeChange?: () => void): {
  pageSize: number;
  containerRef: (node: HTMLDivElement | null) => void;
  onViewModeChange: (mode: ViewMode) => void;
} {
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const grid = viewMode === "grid";
  const [measured, setMeasured] = useState<{ list: number; grid: number }>({
    list: LIST_ITEM_HEIGHT,
    grid: GRID_ROW_HEIGHT,
  });
  const rowHeight = grid ? measured.grid : measured.list;
  const { pageSize, containerRef: sizeRef } = useDynamicPageSize(rowHeight, {
    perRow: grid ? gridColumns : undefined,
    minRows: 2,
    // The last item's gap below it needs no room
    overhead: -(grid ? GRID_GAP : LIST_GAP),
  });

  // Measure the first drawn items of each view: the average height of the slotted items in the box.
  // The box is state, because the list mounts it only after its loader, and the observer must
  // follow it.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const settled = useRef<{ list: boolean; grid: boolean }>({ list: false, grid: false });
  const measure = useCallback(() => {
    const key = grid ? "grid" : "list";
    if (settled.current[key]) return;
    const items = box?.querySelectorAll<HTMLElement>('[data-slotted="true"]');
    if (!items || items.length === 0) return;
    settled.current[key] = true;
    const total = Array.from(items).reduce((sum, item) => sum + item.offsetHeight, 0);
    const average = Math.round(total / items.length + (grid ? GRID_GAP : LIST_GAP));
    setMeasured((current) => (average === current[key] ? current : { ...current, [key]: average }));
  }, [box, grid]);
  useEffect(() => {
    if (!box) return;
    const observer = new MutationObserver(() => measure());
    observer.observe(box, { childList: true, subtree: true });
    measure();
    return () => observer.disconnect();
  }, [box, measure]);

  const containerRef = useCallback(
    (node: HTMLDivElement | null) => {
      setBox(node);
      sizeRef(node);
    },
    [sizeRef],
  );

  const notify = useRef(onPageSizeChange);
  notify.current = onPageSizeChange;
  const previous = useRef(pageSize);
  useEffect(() => {
    if (previous.current === pageSize) return;
    previous.current = pageSize;
    notify.current?.();
  }, [pageSize]);

  const onViewModeChange = useCallback((mode: ViewMode) => setViewMode(mode), []);
  return { pageSize, containerRef, onViewModeChange };
}
