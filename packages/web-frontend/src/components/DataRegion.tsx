import React, { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { InlineError } from "@/components/inline-error";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Presentation of one request owner; a successful empty result is still a result. */
export function DataRegion({
  hasResult,
  pending,
  error,
  onRetry,
  children,
  className,
  testId,
  resultScope,
  initialContent,
  retryLabel,
}: {
  hasResult: boolean;
  pending: boolean;
  error?: string | null;
  onRetry?: () => void | Promise<unknown>;
  children?: ReactNode;
  className?: string;
  testId?: string;
  /** Describes the accepted result, independently of the currently requested controls. */
  resultScope?: ReactNode;
  initialContent?: ReactNode;
  retryLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("min-w-0", className)} aria-busy={pending} data-testid={testId}>
      {hasResult && (pending || error) && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          {t(pending ? "common.dataRegion.updating" : "common.dataRegion.previousResult")}
        </p>
      )}
      {hasResult && resultScope && (
        <div className="mb-3 text-xs text-muted-foreground">{resultScope}</div>
      )}
      {error && (
        <div className="mb-3">
          <InlineError
            title={t("common.errors.failedToLoad")}
            message={error}
            onRetry={onRetry ? () => void onRetry() : undefined}
            retryLabel={retryLabel ?? t("common.dataRegion.retry")}
          />
        </div>
      )}
      {hasResult
        ? children
        : pending
          ? (initialContent ?? (
              <div role="status" aria-label={t("common.dataRegion.loading")}>
                <Skeleton className="h-24 w-full" />
              </div>
            ))
          : null}
    </div>
  );
}
