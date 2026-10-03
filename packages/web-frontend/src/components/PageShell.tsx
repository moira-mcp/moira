/**
 * PageShell — standardized page layout wrapper.
 * Provides consistent page structure: padding, title, description, error/loading states.
 * Use for all standard data pages. Auth pages, detail pages, and settings
 * have justified different layouts and should NOT use PageShell.
 */

import React from "react";
import { PageHeader } from "@/components/page-header";
import { PageLoader } from "@/components/page-loader";
import { DataRegion } from "@/components/DataRegion";

interface PageShellProps {
  title: string;
  description?: string;
  /** Actions slot rendered to the right of the title */
  actions?: React.ReactNode;
  loading?: boolean;
  /** Keeps an accepted result mounted during a subsequent request, including an empty result. */
  hasResult?: boolean;
  error?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  children?: React.ReactNode;
  /** Additional class name for the root container */
  className?: string;
  /** The guide anchor of the page's title, where its screen tour starts (in every state). */
  guide?: { "data-guide": string };
}

export const PageShell: React.FC<PageShellProps> = ({
  title,
  description,
  actions,
  loading,
  hasResult,
  error,
  onRetry,
  retryLabel,
  children,
  className,
  guide,
}) => {
  return (
    <div className={className || "h-full flex flex-col p-6 md:p-8"}>
      <PageHeader title={title} description={description} guide={guide}>
        {actions}
      </PageHeader>
      <DataRegion
        hasResult={hasResult ?? !(loading || error)}
        pending={Boolean(loading)}
        error={error}
        onRetry={onRetry}
        retryLabel={retryLabel}
        initialContent={<PageLoader />}
        className="flex flex-1 min-h-0 flex-col"
      >
        {children}
      </DataRegion>
    </div>
  );
};
