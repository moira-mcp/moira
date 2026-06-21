/**
 * Audit Log Page
 * View system audit trail with filtering and pagination
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "../services/api-client";
import { PageShell } from "../components/PageShell";
import { FilterBar } from "@/components/FilterBar";
import { LabeledFilter } from "@/components/LabeledFilter";
import { SortSelect } from "@/components/SortSelect";
import { useDebounce } from "@/hooks/useDebounce";
import { useDynamicPageSize } from "@/hooks/useDynamicPageSize";
import { formatDate } from "@/components/cards/format-utils";
import { AuditLogCard } from "@/components/cards/AuditLogCard";
import type { AuditLogCardData } from "@/components/cards/AuditLogCard";
import { DataListView } from "@/components/DataListView";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/SearchableSelect";

interface AuditChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

// Source types for audit events
const AUDIT_SOURCES = ["web", "mcp", "api", "system"] as const;

const getActionBadgeClasses = (action: string) => {
  if (
    action.includes("CREATE") ||
    action.includes("REGISTER") ||
    action.includes("VERIFY") ||
    action.includes("sign_up")
  ) {
    return "border-transparent bg-success text-success-foreground";
  }
  if (action.includes("DELETE") || action.includes("BLOCK")) {
    return "border-transparent bg-destructive/10 text-destructive";
  }
  if (action.includes("UPDATE") || action.includes("EDIT") || action.includes("RESTORE")) {
    return "border-transparent bg-info text-info-foreground";
  }
  if (action.includes("sign_in") || action.includes("sign_out")) {
    return "border-transparent bg-chart-4/20 text-chart-4";
  }
  return undefined; // will use variant="secondary"
};

export const AuditLog: React.FC = () => {
  const { t } = useTranslation();
  const { pageSize: itemsPerPage, containerRef } = useDynamicPageSize();
  const [entries, setEntries] = useState<AuditLogCardData[]>([]);
  const [users, setUsers] = useState<{ id: string; email: string; name: string | null }[]>([]);
  const [auditActions, setAuditActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [selectedEntry, setSelectedEntry] = useState<AuditLogCardData | null>(null);

  // Filter state (immediate UI values)
  const [userIdInput, setUserIdInput] = useState<string>("");
  const [actionsInput, setActionsInput] = useState<string[]>([]);
  const [resourceInput, setResourceInput] = useState<string>("");
  const [sourceInput, setSourceInput] = useState<string>("");

  // Debounced filter values (used for API calls)
  const debouncedUserId = useDebounce(userIdInput, 400);
  const debouncedActions = useDebounce(actionsInput, 400);
  const debouncedResource = useDebounce(resourceInput, 400);
  const debouncedSource = useDebounce(sourceInput, 400);

  // Action dropdown UI state
  const [actionDropdownOpen, setActionDropdownOpen] = useState(false);

  // Sorting
  const [sortBy, setSortBy] = useState<"createdAt" | "action" | "resource" | "source">("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Date range filter
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);

  // Reset page when any debounced filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedUserId, debouncedActions, debouncedResource, debouncedSource]);

  // Load audit actions on mount (once)
  useEffect(() => {
    const loadAuditActions = async () => {
      try {
        const actionsData = await apiClient.getAuditActions();
        setAuditActions(actionsData.actions);
      } catch {
        // Fallback to empty array - user can still see entries, just no filter options
      }
    };
    loadAuditActions();
  }, []);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);

      // Build filters for server-side query
      const filters: {
        userId?: string;
        action?: string;
        resource?: string;
        source?: string;
        fromDate?: number;
        toDate?: number;
        sortBy?: string;
        sortOrder?: string;
        limit: number;
        offset: number;
      } = {
        limit: itemsPerPage,
        offset: (currentPage - 1) * itemsPerPage,
        sortBy,
        sortOrder,
      };
      if (debouncedUserId) filters.userId = debouncedUserId;
      if (debouncedActions.length > 0) filters.action = debouncedActions.join(",");
      if (debouncedResource) filters.resource = debouncedResource;
      if (debouncedSource) filters.source = debouncedSource;
      if (fromDate) filters.fromDate = new Date(fromDate).getTime();
      if (toDate) {
        // Set to end of day
        const endOfDay = new Date(toDate);
        endOfDay.setHours(23, 59, 59, 999);
        filters.toDate = endOfDay.getTime();
      }

      const [auditData, usersData] = await Promise.all([
        apiClient.getAuditLogs(filters),
        apiClient.getAdminUsers(),
      ]);

      setEntries(auditData.entries);
      setTotal(auditData.total);
      setUsers(usersData.users.map((u) => ({ id: u.id, email: u.email, name: u.name })));
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load audit log";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [
    debouncedUserId,
    debouncedActions,
    debouncedResource,
    debouncedSource,
    currentPage,
    itemsPerPage,
    sortBy,
    sortOrder,
    fromDate,
    toDate,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleEntryClick = (entry: AuditLogCardData) => {
    setSelectedEntry(entry);
  };

  const closeDetail = () => {
    setSelectedEntry(null);
  };

  const clearFilters = () => {
    setUserIdInput("");
    setActionsInput([]);
    setResourceInput("");
    setSourceInput("");
    setFromDate("");
    setToDate("");
    setSortBy("createdAt");
    setSortOrder("desc");
    setCurrentPage(1);
  };

  const toggleAction = (action: string) => {
    if (actionsInput.includes(action)) {
      setActionsInput(actionsInput.filter((a) => a !== action));
    } else {
      setActionsInput([...actionsInput, action]);
    }
  };

  const handleSortChange = (value: string) => {
    const [newSortBy, newSortOrder] = value.split("-") as [
      "createdAt" | "action" | "resource" | "source",
      "asc" | "desc",
    ];
    setSortBy(newSortBy);
    setSortOrder(newSortOrder);
    setCurrentPage(1);
  };

  const renderActionBadge = (action: string) => {
    const classes = getActionBadgeClasses(action);
    if (classes) {
      return <Badge className={classes}>{action}</Badge>;
    }
    return <Badge variant="secondary">{action}</Badge>;
  };

  if (loading && entries.length === 0) {
    return (
      <PageShell
        title={t("admin.auditLog.title")}
        description={t("admin.auditLog.subtitle")}
        loading
      />
    );
  }

  if (error && entries.length === 0) {
    return (
      <PageShell
        title={t("admin.auditLog.title")}
        description={t("admin.auditLog.subtitle")}
        error={error}
        onRetry={loadData}
      />
    );
  }

  return (
    <PageShell title={t("admin.auditLog.title")} description={t("admin.auditLog.subtitle")}>
      <FilterBar
        search={resourceInput}
        onSearchChange={setResourceInput}
        searchPlaceholder={t("admin.auditLog.filters.resourcePlaceholder")}
        onReset={clearFilters}
        filters={
          <>
            {/* User Filter */}
            <LabeledFilter label={t("common.filters.user")}>
              <SearchableSelect
                value={userIdInput || "__all__"}
                onValueChange={(v) => setUserIdInput(v === "__all__" ? "" : v)}
                options={[
                  { value: "__all__", label: t("admin.auditLog.filters.allUsers") },
                  ...users.map((user) => ({ value: user.id, label: user.email })),
                ]}
                placeholder={t("admin.auditLog.filters.allUsers")}
                searchPlaceholder={t("common.filters.search")}
              />
            </LabeledFilter>

            {/* Action Filter - Multi-select with Popover + Command */}
            <LabeledFilter label={t("common.filters.action")}>
              <Popover open={actionDropdownOpen} onOpenChange={setActionDropdownOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-[200px] justify-start font-normal">
                    {actionsInput.length === 0 ? (
                      <span className="text-muted-foreground">
                        {t("admin.auditLog.filters.selectActions")}
                      </span>
                    ) : (
                      <span className="text-sm">
                        {t("admin.auditLog.filters.selected", { count: actionsInput.length })}
                      </span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                  align="start"
                  side="bottom"
                  avoidCollisions
                  collisionPadding={16}
                >
                  <Command>
                    <CommandInput placeholder={t("admin.auditLog.filters.searchActions")} />
                    <CommandList>
                      <CommandEmpty>No actions found.</CommandEmpty>
                      <CommandGroup>
                        {auditActions.map((action) => (
                          <CommandItem
                            key={action}
                            value={action}
                            onSelect={() => toggleAction(action)}
                          >
                            <Checkbox checked={actionsInput.includes(action)} className="mr-2" />
                            <span className="text-sm">{action}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </LabeledFilter>

            {/* Source Filter */}
            <LabeledFilter label={t("common.filters.source")}>
              <Select
                value={sourceInput || "__all__"}
                onValueChange={(v) => setSourceInput(v === "__all__" ? "" : v)}
              >
                <SelectTrigger className="w-[160px]">
                  <SelectValue placeholder={t("admin.auditLog.filters.allSources")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">{t("admin.auditLog.filters.allSources")}</SelectItem>
                  {AUDIT_SOURCES.map((source) => (
                    <SelectItem key={source} value={source}>
                      {source.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledFilter>

            {/* Date Range */}
            <LabeledFilter label={t("common.filters.dateFrom")}>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setFromDate(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-[160px]"
                placeholder={t("admin.auditLog.filters.fromDate")}
              />
            </LabeledFilter>
            <LabeledFilter label={t("common.filters.dateTo")}>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => {
                  setToDate(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-[160px]"
                placeholder={t("admin.auditLog.filters.toDate")}
              />
            </LabeledFilter>

            {/* Sort */}
            <SortSelect
              value={`${sortBy}-${sortOrder}`}
              onChange={handleSortChange}
              label={t("common.filters.sort")}
              options={[
                {
                  value: "createdAt-desc",
                  label: `${t("admin.auditLog.table.timestamp")} ↓`,
                },
                {
                  value: "createdAt-asc",
                  label: `${t("admin.auditLog.table.timestamp")} ↑`,
                },
                {
                  value: "action-asc",
                  label: `${t("admin.auditLog.table.action")} ↑`,
                },
                {
                  value: "action-desc",
                  label: `${t("admin.auditLog.table.action")} ↓`,
                },
                {
                  value: "resource-asc",
                  label: `${t("admin.auditLog.table.resource")} ↑`,
                },
                {
                  value: "resource-desc",
                  label: `${t("admin.auditLog.table.resource")} ↓`,
                },
                {
                  value: "source-asc",
                  label: `${t("admin.auditLog.table.source")} ↑`,
                },
                {
                  value: "source-desc",
                  label: `${t("admin.auditLog.table.source")} ↓`,
                },
              ]}
              testId="sort-select"
            />
          </>
        }
      />

      {/* Entries */}
      <DataListView
        items={entries}
        renderCard={(entry, viewMode) => (
          <AuditLogCard entry={entry} compact={viewMode === "grid"} onClick={handleEntryClick} />
        )}
        keyExtractor={(e) => e.id}
        storageKey="audit-log-view-mode"
        loading={loading}
        emptyTitle={t("admin.auditLog.noEntries")}
        emptyDescription={t("admin.auditLog.subtitle")}
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage,
          totalPages: Math.ceil(total / itemsPerPage),
          totalItems: total,
          pageSize: itemsPerPage,
          onPageChange: setCurrentPage,
        }}
        className="flex-1 min-h-0 flex flex-col"
      />

      {/* Detail Dialog */}
      <Dialog open={!!selectedEntry} onOpenChange={(open) => !open && closeDetail()}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("admin.auditLog.detail.title")}</DialogTitle>
          </DialogHeader>

          {selectedEntry && (
            <div className="space-y-4">
              <div>
                <Label className="text-muted-foreground">{t("admin.auditLog.detail.id")}</Label>
                <p className="text-foreground font-mono text-sm">{selectedEntry.id}</p>
              </div>

              <div>
                <Label className="text-muted-foreground">
                  {t("admin.auditLog.detail.timestamp")}
                </Label>
                <p className="text-foreground">{formatDate(selectedEntry.createdAt)}</p>
              </div>

              <div>
                <Label className="text-muted-foreground">{t("admin.auditLog.detail.user")}</Label>
                <p className="text-foreground">
                  {selectedEntry.userEmail || t("admin.auditLog.system")}
                </p>
                {selectedEntry.userName && (
                  <p className="text-muted-foreground text-sm">{selectedEntry.userName}</p>
                )}
              </div>

              <div>
                <Label className="text-muted-foreground">{t("admin.auditLog.detail.action")}</Label>
                <div className="mt-1">{renderActionBadge(selectedEntry.action)}</div>
              </div>

              {selectedEntry.resource && (
                <div>
                  <Label className="text-muted-foreground">
                    {t("admin.auditLog.detail.resource")}
                  </Label>
                  <p className="text-foreground">{selectedEntry.resource}</p>
                </div>
              )}

              {selectedEntry.resourceId && (
                <div>
                  <Label className="text-muted-foreground">
                    {t("admin.auditLog.detail.resourceId")}
                  </Label>
                  <p className="text-foreground font-mono text-sm break-all">
                    {selectedEntry.resourceId}
                  </p>
                </div>
              )}

              {selectedEntry.source && (
                <div>
                  <Label className="text-muted-foreground">
                    {t("admin.auditLog.detail.source")}
                  </Label>
                  <div className="mt-1">
                    <Badge variant="secondary">{selectedEntry.source.toUpperCase()}</Badge>
                  </div>
                </div>
              )}

              {selectedEntry.ip && (
                <div>
                  <Label className="text-muted-foreground">
                    {t("admin.auditLog.detail.ipAddress")}
                  </Label>
                  <p className="text-foreground">{selectedEntry.ip}</p>
                </div>
              )}

              {selectedEntry.country && (
                <div>
                  <Label className="text-muted-foreground">
                    {t("admin.auditLog.detail.country")}
                  </Label>
                  <p className="text-foreground">{selectedEntry.country}</p>
                </div>
              )}

              {selectedEntry.userAgent && (
                <div>
                  <Label className="text-muted-foreground">
                    {t("admin.auditLog.detail.userAgent")}
                  </Label>
                  <p className="text-foreground text-sm break-words">{selectedEntry.userAgent}</p>
                </div>
              )}

              {selectedEntry.metadata &&
                (() => {
                  try {
                    const meta = JSON.parse(selectedEntry.metadata);
                    const isExecutionAction = selectedEntry.action.startsWith("execution:");

                    // Render execution metadata with special formatting
                    if (isExecutionAction && typeof meta === "object") {
                      return (
                        <div>
                          <Label className="text-muted-foreground mb-2 block">
                            {t("admin.auditLog.detail.metadata")}
                          </Label>
                          <div
                            className="space-y-2 p-3 bg-muted rounded border border-border"
                            data-testid="execution-metadata"
                          >
                            {meta.workflowId && (
                              <div className="flex justify-between">
                                <span className="text-sm text-muted-foreground">
                                  {t("admin.auditLog.detail.workflowId")}
                                </span>
                                <span className="text-sm font-mono text-foreground">
                                  {meta.workflowId}
                                </span>
                              </div>
                            )}
                            {meta.fromNodeId && (
                              <div className="flex justify-between">
                                <span className="text-sm text-muted-foreground">
                                  {t("admin.auditLog.detail.fromNode")}
                                </span>
                                <span className="text-sm font-mono text-foreground">
                                  {meta.fromNodeId}
                                </span>
                              </div>
                            )}
                            {meta.toNodeId && (
                              <div className="flex justify-between">
                                <span className="text-sm text-muted-foreground">
                                  {t("admin.auditLog.detail.toNode")}
                                </span>
                                <span className="text-sm font-mono text-foreground">
                                  {meta.toNodeId}
                                </span>
                              </div>
                            )}
                            {meta.nodeId && (
                              <div className="flex justify-between">
                                <span className="text-sm text-muted-foreground">
                                  {t("admin.auditLog.detail.nodeId")}
                                </span>
                                <span className="text-sm font-mono text-foreground">
                                  {meta.nodeId}
                                </span>
                              </div>
                            )}
                            {meta.totalSteps !== undefined && (
                              <div className="flex justify-between">
                                <span className="text-sm text-muted-foreground">
                                  {t("admin.auditLog.detail.totalSteps")}
                                </span>
                                <span className="text-sm font-mono text-foreground">
                                  {meta.totalSteps}
                                </span>
                              </div>
                            )}
                            {meta.durationMs !== undefined && (
                              <div className="flex justify-between">
                                <span className="text-sm text-muted-foreground">
                                  {t("admin.auditLog.detail.duration")}
                                </span>
                                <span className="text-sm font-mono text-foreground">
                                  {meta.durationMs < 1000
                                    ? `${meta.durationMs}ms`
                                    : `${(meta.durationMs / 1000).toFixed(2)}s`}
                                </span>
                              </div>
                            )}
                            {meta.error && (
                              <div className="mt-2 pt-2 border-t border-border">
                                <span className="text-sm text-destructive font-medium">
                                  {t("admin.auditLog.detail.error")}
                                </span>
                                <pre className="mt-1 text-xs text-destructive whitespace-pre-wrap">
                                  {meta.error}
                                </pre>
                              </div>
                            )}
                            {meta.validationError && (
                              <div className="mt-2 pt-2 border-t border-border">
                                <span className="text-sm text-chart-4 font-medium">
                                  {t("admin.auditLog.detail.validationError")}
                                </span>
                                <pre className="mt-1 text-xs text-chart-4 whitespace-pre-wrap">
                                  {meta.validationError}
                                </pre>
                              </div>
                            )}
                            {meta.input !== undefined && (
                              <div className="mt-2 pt-2 border-t border-border">
                                <span className="text-sm text-muted-foreground font-medium">
                                  {t("admin.auditLog.detail.input")}
                                </span>
                                <pre className="mt-1 text-xs text-foreground whitespace-pre-wrap bg-muted p-2 rounded">
                                  {typeof meta.input === "object"
                                    ? JSON.stringify(meta.input, null, 2)
                                    : String(meta.input)}
                                </pre>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }

                    // Default JSON rendering for non-execution metadata
                    return (
                      <div>
                        <Label className="text-muted-foreground">
                          {t("admin.auditLog.detail.metadata")}
                        </Label>
                        <pre className="mt-2 p-3 bg-muted rounded border border-border text-sm overflow-x-auto">
                          {JSON.stringify(meta, null, 2)}
                        </pre>
                      </div>
                    );
                  } catch {
                    // If JSON parsing fails, show raw metadata
                    return (
                      <div>
                        <Label className="text-muted-foreground">
                          {t("admin.auditLog.detail.metadata")}
                        </Label>
                        <pre className="mt-2 p-3 bg-muted rounded border border-border text-sm overflow-x-auto">
                          {selectedEntry.metadata}
                        </pre>
                      </div>
                    );
                  }
                })()}

              {selectedEntry.changes &&
                (() => {
                  try {
                    const changes = JSON.parse(selectedEntry.changes) as AuditChange[];
                    if (changes.length === 0) return null;
                    return (
                      <div>
                        <Label className="text-muted-foreground mb-2 block">
                          {t("admin.auditLog.detail.changes")}
                        </Label>
                        <div className="space-y-2" data-testid="audit-changes">
                          {changes.map((change, index) => (
                            <div key={index} className="p-3 bg-muted rounded border border-border">
                              <div className="text-sm font-medium text-foreground mb-1">
                                {change.field}
                              </div>
                              <div className="flex items-center gap-2 text-sm">
                                <span className="px-2 py-0.5 bg-destructive/10 text-destructive rounded font-mono text-xs">
                                  {change.oldValue === null
                                    ? "null"
                                    : typeof change.oldValue === "object"
                                      ? JSON.stringify(change.oldValue)
                                      : String(change.oldValue)}
                                </span>
                                <span className="text-muted-foreground">→</span>
                                <span className="px-2 py-0.5 bg-success/10 text-success rounded font-mono text-xs">
                                  {change.newValue === null
                                    ? "null"
                                    : typeof change.newValue === "object"
                                      ? JSON.stringify(change.newValue)
                                      : String(change.newValue)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  } catch {
                    return null;
                  }
                })()}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
};
