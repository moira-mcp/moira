/**
 * Top Workflows Table
 * Shared DataTable-based component used by AdminDashboard and AdminAnalytics
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "./data-table/data-table";

export interface TopWorkflow {
  workflowId: string;
  workflowName: string;
  executionCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
  avgDurationMs: number | null;
}

const formatDuration = (ms: number | null): string => {
  if (ms === null) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
};

const formatPercentage = (value: number): string => `${value.toFixed(1)}%`;

interface TopWorkflowsTableProps {
  workflows: TopWorkflow[];
  emptyMessage?: string;
}

export const TopWorkflowsTable: React.FC<TopWorkflowsTableProps> = ({
  workflows,
  emptyMessage,
}) => {
  const { t } = useTranslation();

  const columns: ColumnDef<TopWorkflow>[] = useMemo(
    () => [
      {
        accessorKey: "workflowName",
        header: t("admin.analytics.table.workflow"),
        cell: ({ row }) => (
          <span className="font-medium text-foreground">{row.original.workflowName}</span>
        ),
      },
      {
        accessorKey: "executionCount",
        header: t("admin.analytics.table.executions"),
        cell: ({ row }) => <span className="text-right block">{row.original.executionCount}</span>,
      },
      {
        accessorKey: "completedCount",
        header: t("admin.analytics.table.completed"),
        cell: ({ row }) => (
          <span className="text-right block text-success">{row.original.completedCount}</span>
        ),
      },
      {
        accessorKey: "failedCount",
        header: t("admin.analytics.table.failed"),
        cell: ({ row }) => (
          <span className="text-right block text-destructive">{row.original.failedCount}</span>
        ),
      },
      {
        accessorKey: "successRate",
        header: t("admin.analytics.table.successRate"),
        cell: ({ row }) => (
          <span className="text-right block">{formatPercentage(row.original.successRate)}</span>
        ),
      },
      {
        accessorKey: "avgDurationMs",
        header: t("admin.analytics.table.avgDuration"),
        cell: ({ row }) => (
          <span className="text-right block">{formatDuration(row.original.avgDurationMs)}</span>
        ),
      },
    ],
    [t],
  );

  return (
    <DataTable
      columns={columns}
      data={workflows}
      emptyMessage={emptyMessage || t("admin.analytics.noWorkflowData")}
      showPagination={false}
      showToolbar={false}
    />
  );
};
