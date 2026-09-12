/**
 * The in-layout fallback while a lazily loaded page's code arrives: the sidebar and the frame
 * stay where they are and only the content area shows a quiet skeleton, so moving between
 * sections never blanks the application.
 */

import { Skeleton } from "@/components/ui/skeleton";

export function RouteSkeleton() {
  return (
    <div
      className="h-full space-y-4 p-6 md:p-8"
      role="status"
      aria-live="polite"
      data-testid="route-skeleton"
    >
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="flex gap-2 pt-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-[45vh] w-full" />
    </div>
  );
}

/** The fallback while a diagram's code (the technical graph chunk) arrives: a quiet surface. */
export function DiagramSkeleton() {
  return (
    <div
      className="h-full min-h-[320px] p-4"
      role="status"
      aria-live="polite"
      data-testid="diagram-skeleton"
    >
      <Skeleton className="h-full w-full" />
    </div>
  );
}
