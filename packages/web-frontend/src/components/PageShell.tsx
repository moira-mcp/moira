/**
 * PageShell — standardized page layout wrapper.
 * Provides consistent page structure: padding, title, description, error/loading states.
 * Use for all standard data pages. Auth pages, detail pages, and settings
 * have justified different layouts and should NOT use PageShell.
 */

import React from "react";
import { PageHeader } from "@/components/page-header";
import { PageLoader } from "@/components/page-loader";
import { InlineError } from "@/components/inline-error";

interface PageShellProps {
  title: string;
  description?: string;
  /** Actions slot rendered to the right of the title */
  actions?: React.ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  children?: React.ReactNode;
  /** Additional class name for the root container */
  className?: string;
}

export const PageShell: React.FC<PageShellProps> = ({
  title,
  description,
  actions,
  loading,
  error,
  onRetry,
  retryLabel,
  children,
  className,
}) => {
  if (loading) {
    return (
      <div className={className || "h-full flex flex-col p-6 md:p-8"}>
        <PageHeader title={title} description={description}>
          {actions}
        </PageHeader>
        <PageLoader />
      </div>
    );
  }

  if (error) {
    return (
      <div className={className || "h-full flex flex-col p-6 md:p-8"}>
        <PageHeader title={title} description={description}>
          {actions}
        </PageHeader>
        <InlineError message={error} onRetry={onRetry} retryLabel={retryLabel} />
      </div>
    );
  }

  return (
    <div className={className || "h-full flex flex-col p-6 md:p-8"}>
      <PageHeader title={title} description={description}>
        {actions}
      </PageHeader>
      {children}
    </div>
  );
};
