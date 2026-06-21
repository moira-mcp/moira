/**
 * ExecutionErrorHistory Component
 * Displays execution error log with timestamps and error details
 * Issue #386: Execution Error Log System
 */

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Clock, Code, XCircle, AlertCircle, Cog, Copy, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Error type from API (matches ExecutionError from shared package)
export interface ExecutionErrorEntry {
  timestamp: number;
  nodeId: string;
  errorType: "validation" | "handler" | "system";
  message: string;
  input?: unknown;
}

interface ExecutionErrorHistoryProps {
  errors: ExecutionErrorEntry[];
  className?: string;
}

// Get icon for error type with severity-based colors
function getErrorTypeIcon(errorType: ExecutionErrorEntry["errorType"]) {
  switch (errorType) {
    case "validation":
      return <AlertTriangle className="h-4 w-4 text-chart-5" />;
    case "handler":
      return <AlertCircle className="h-4 w-4 text-chart-4" />;
    case "system":
      return <Cog className="h-4 w-4 text-destructive" />;
  }
}

// Get badge variant for error type
function getErrorTypeBadgeVariant(
  errorType: ExecutionErrorEntry["errorType"],
): "default" | "secondary" | "destructive" | "outline" {
  switch (errorType) {
    case "validation":
      return "default";
    case "handler":
      return "secondary";
    case "system":
      return "destructive";
  }
}

// Format timestamp
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

// Format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

// Format error for clipboard
function formatErrorForClipboard(error: ExecutionErrorEntry): string {
  const lines = [
    `Error Type: ${error.errorType}`,
    `Node: ${error.nodeId}`,
    `Timestamp: ${formatTimestamp(error.timestamp)}`,
    `Message: ${error.message}`,
  ];
  if (error.input !== undefined) {
    lines.push(
      `Input: ${typeof error.input === "string" ? error.input : JSON.stringify(error.input, null, 2)}`,
    );
  }
  return lines.join("\n");
}

export function ExecutionErrorHistory({ errors, className }: ExecutionErrorHistoryProps) {
  const { t } = useTranslation();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopyError = useCallback(async (error: ExecutionErrorEntry, index: number) => {
    const text = formatErrorForClipboard(error);
    await navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  }, []);

  // Handle empty/null errors gracefully
  if (!errors || errors.length === 0) {
    return (
      <Card className={cn("", className)}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4" />
            {t("components.executionErrors.title", "Error History")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("components.executionErrors.noErrors", "No errors recorded")}
          </p>
        </CardContent>
      </Card>
    );
  }

  // Sort errors by timestamp, newest first
  const sortedErrors = [...errors].sort((a, b) => b.timestamp - a.timestamp);

  return (
    <Card className={cn("", className)}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <XCircle className="h-4 w-4 text-destructive" />
          {t("components.executionErrors.title", "Error History")}
          <Badge variant="destructive" className="ml-auto">
            {errors.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sortedErrors.map((error, index) => (
          <Collapsible key={`${error.timestamp}-${index}`}>
            <div className="rounded-lg border bg-muted/30 p-3">
              <CollapsibleTrigger className="w-full">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 text-muted-foreground">
                    {getErrorTypeIcon(error.errorType)}
                  </div>
                  <div className="flex-1 text-left">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={getErrorTypeBadgeVariant(error.errorType)}>
                        {t(
                          `components.executionErrors.errorTypes.${error.errorType}`,
                          error.errorType,
                        )}
                      </Badge>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatRelativeTime(error.timestamp)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm font-medium whitespace-pre-wrap break-words">
                      {error.message}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("components.executionErrors.node", "Node")}: {error.nodeId}
                    </p>
                  </div>
                </div>
              </CollapsibleTrigger>

              <CollapsibleContent>
                <div className="mt-3 pt-3 border-t space-y-2">
                  {/* Copy button */}
                  <div className="flex justify-end">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyError(error, index);
                          }}
                          className="h-7 px-2"
                          data-testid={`copy-error-${index}`}
                          aria-label={t(
                            "components.executionErrors.copyAriaLabel",
                            "Copy error details to clipboard",
                          )}
                        >
                          {copiedIndex === index ? (
                            <Check className="h-3 w-3 text-chart-2" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          <span className="ml-1 text-xs">
                            {copiedIndex === index
                              ? t("components.executionErrors.copied", "Copied!")
                              : t("components.executionErrors.copy", "Copy")}
                          </span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t(
                          "components.executionErrors.copyTooltip",
                          "Copy error details for debugging",
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  {/* Full timestamp */}
                  <div className="text-xs">
                    <span className="font-medium text-muted-foreground">
                      {t("components.executionErrors.timestamp", "Timestamp")}:
                    </span>{" "}
                    {formatTimestamp(error.timestamp)}
                  </div>

                  {/* Full message */}
                  <div className="text-xs">
                    <span className="font-medium text-muted-foreground">
                      {t("components.executionErrors.message", "Message")}:
                    </span>
                    <p className="mt-1 p-2 bg-muted rounded text-xs font-mono whitespace-pre-wrap break-words">
                      {error.message}
                    </p>
                  </div>

                  {/* Input if present */}
                  {error.input !== undefined && (
                    <div className="text-xs">
                      <span className="font-medium text-muted-foreground flex items-center gap-1">
                        <Code className="h-3 w-3" />
                        {t("components.executionErrors.input", "Input")}:
                      </span>
                      <pre className="mt-1 p-2 bg-muted rounded text-xs font-mono overflow-x-auto max-h-32">
                        {typeof error.input === "string"
                          ? error.input
                          : JSON.stringify(error.input, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </div>
          </Collapsible>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Error count badge component for list views
 */
interface ErrorCountBadgeProps {
  count: number;
  className?: string;
}

export function ErrorCountBadge({ count, className }: ErrorCountBadgeProps) {
  if (!count || count === 0) return null;

  return (
    <Badge
      variant="destructive"
      className={cn("gap-1", className)}
      title={`${count} error${count > 1 ? "s" : ""}`}
    >
      <AlertTriangle className="h-3 w-3" />
      {count}
    </Badge>
  );
}
