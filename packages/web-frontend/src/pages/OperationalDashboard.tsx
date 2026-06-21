/**
 * Operational Metrics Dashboard
 * Real-time system metrics at /admin/operational
 * Shows business analytics (funnel, top workflows, engagement) + 6 operational metrics
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AreaChart, BarChart, LineChart } from "@tremor/react";
import type { CustomTooltipProps } from "@tremor/react";
import { apiClient } from "../services/api-client";
import { PageShell } from "../components/PageShell";
import { StatCard } from "../components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LucideIcon } from "lucide-react";
import {
  RefreshCw,
  Activity,
  Users,
  Zap,
  Play,
  CheckCircle,
  Radio,
  Clock,
  Calendar,
  TrendingUp,
  UserCheck,
  BarChart3,
  Target,
  Filter,
  LineChart as LineChartIcon,
  AreaChart as AreaChartIcon,
  BarChart2,
} from "lucide-react";

type TimeRange = "today" | "week" | "month" | "year" | "all";
type Granularity = "auto" | "hourly" | "daily";
type ChartType = "area" | "line" | "bar";

interface ActiveFilters {
  action?: string;
  source?: string;
  resource?: string;
}

interface OperationalMetric {
  name: string;
  value: number;
  available: boolean;
  unit: string;
  timeSeries: Array<{ date: string; value: number }>;
}

interface BreakdownItem {
  label: string;
  count: number;
}

interface Breakdowns {
  byAction: BreakdownItem[];
  bySource: BreakdownItem[];
  byResource: BreakdownItem[];
}

interface FunnelStage {
  stage: string;
  label: string;
  count: number;
}

interface TopWorkflow {
  workflowId: string;
  workflowName: string;
  executionCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
  avgDurationMs: number | null;
}

interface EngagementData {
  returningUsersRate: number;
  returningUsersCount: number;
  totalActiveUsers: number;
  avgExecutionsPerUser: number;
  avgTimeToFirstWorkflowDays: number | null;
  activeUsersTrend: Array<{ date: string; value: number }>;
}

const METRIC_ICONS: Record<string, LucideIcon> = {
  unique_users_per_day: Users,
  total_calls_per_day: Activity,
  calls_per_second: Zap,
  workflows_started_per_day: Play,
  workflows_completed_per_day: CheckCircle,
  mcp_calls_per_second: Radio,
};

const RATE_METRICS = new Set(["calls_per_second", "mcp_calls_per_second"]);

function formatMetricValue(name: string, value: number): string {
  if (RATE_METRICS.has(name)) {
    return value < 0.01 && value > 0 ? "<0.01/s" : `${value.toFixed(2)}/s`;
  }
  return String(value);
}

function formatDateLabel(dateStr: string, granularity: string): string {
  if (granularity === "hourly" && dateStr.includes(" ")) {
    return dateStr.split(" ")[1] || dateStr;
  }
  const parts = dateStr.split("-");
  return parts.length >= 3 ? `${parts[1]}-${parts[2]}` : dateStr;
}

/** Custom tooltip for tremor charts */
function ChartTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-md border bg-popover p-2 shadow-md text-popover-foreground text-xs"
      data-testid="chart-tooltip"
    >
      <p className="font-medium mb-1">{String(label ?? "")}</p>
      {payload.map((entry, i) => (
        <div key={String(entry.name ?? i)} className="flex items-center gap-2">
          {entry.color && (
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: entry.color }}
            />
          )}
          <span className="text-muted-foreground">{String(entry.name ?? "")}:</span>
          <span className="font-medium">
            {typeof entry.value === "number"
              ? entry.value.toLocaleString()
              : String(entry.value ?? "")}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Time series chart using tremor — supports area/line/bar toggle */
function TimeSeriesChart({
  data,
  granularity,
  metricName,
  testId,
  chartType = "area",
}: {
  data: Array<{ date: string; value: number }>;
  granularity: string;
  metricName: string;
  testId?: string;
  chartType?: ChartType;
}) {
  const chartData = data.map((point) => ({
    label: formatDateLabel(point.date, granularity),
    [metricName]: point.value,
  }));

  const commonProps = {
    className: "h-40",
    data: chartData,
    index: "label" as const,
    categories: [metricName],
    colors: ["blue" as const],
    showLegend: true,
    showAnimation: true,
    valueFormatter: (v: number) => v.toLocaleString(),
    customTooltip: ChartTooltip,
  };

  return (
    <div data-testid={testId}>
      {chartType === "line" ? (
        <LineChart {...commonProps} curveType="monotone" />
      ) : chartType === "bar" ? (
        <BarChart {...commonProps} />
      ) : (
        <AreaChart {...commonProps} curveType="monotone" />
      )}
    </div>
  );
}

/** Multi-series comparison chart — overlays multiple data series on same axis */
function MultiSeriesChart({
  series,
  granularity,
  chartType = "area",
  testId,
}: {
  series: Array<{ name: string; data: Array<{ date: string; value: number }> }>;
  granularity: string;
  chartType?: ChartType;
  testId?: string;
}) {
  const dateSet = new Set<string>();
  for (const s of series) {
    for (const p of s.data) dateSet.add(p.date);
  }
  const dates = [...dateSet].sort();

  const chartData = dates.map((date) => {
    const point: Record<string, string | number> = { label: formatDateLabel(date, granularity) };
    for (const s of series) {
      const match = s.data.find((p) => p.date === date);
      point[s.name] = match?.value ?? 0;
    }
    return point;
  });

  const categories = series.map((s) => s.name);
  const colors = (["blue", "emerald", "amber", "rose"] as const).slice(0, categories.length);

  const commonProps = {
    className: "h-48",
    data: chartData,
    index: "label" as const,
    categories,
    colors: [...colors],
    showLegend: true,
    showAnimation: true,
    valueFormatter: (v: number) => v.toLocaleString(),
    customTooltip: ChartTooltip,
  };

  return (
    <div data-testid={testId}>
      {chartType === "line" ? (
        <LineChart {...commonProps} curveType="monotone" />
      ) : chartType === "bar" ? (
        <BarChart {...commonProps} />
      ) : (
        <AreaChart {...commonProps} curveType="monotone" />
      )}
    </div>
  );
}

/** Horizontal bar breakdown table */
function BreakdownTable({ items, testId }: { items: BreakdownItem[]; testId?: string }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  const maxCount = Math.max(...items.map((i) => i.count), 1);

  return (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[50%]">{t("admin.operational.breakdowns.name")}</TableHead>
          <TableHead className="w-[15%] text-right">
            {t("admin.operational.breakdowns.count")}
          </TableHead>
          <TableHead className="w-[35%]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.label}>
            <TableCell className="font-mono text-xs">{item.label}</TableCell>
            <TableCell className="text-right font-medium">{item.count}</TableCell>
            <TableCell>
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className="bg-chart-1 h-2 rounded-full transition-all"
                  style={{ width: `${(item.count / maxCount) * 100}%` }}
                />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Conversion Funnel visualization */
function ConversionFunnel({ funnel, testId }: { funnel: FunnelStage[]; testId?: string }) {
  const { t } = useTranslation();
  if (funnel.length === 0) return null;
  const maxCount = Math.max(...funnel.map((s) => s.count), 1);

  const STAGE_LABELS: Record<string, string> = {
    registered: t("admin.businessAnalytics.conversionFunnel.registered"),
    verified: t("admin.businessAnalytics.conversionFunnel.verified"),
    first_workflow: t("admin.businessAnalytics.conversionFunnel.firstWorkflow"),
    active: t("admin.businessAnalytics.conversionFunnel.active"),
  };

  const STAGE_COLORS = ["bg-blue-500", "bg-green-500", "bg-amber-500", "bg-purple-500"];

  return (
    <div className="space-y-3" data-testid={testId}>
      {funnel.map((stage, idx) => {
        const pct = maxCount > 0 ? (stage.count / maxCount) * 100 : 0;
        const convRate =
          idx > 0 && funnel[idx - 1].count > 0
            ? Math.round((stage.count / funnel[idx - 1].count) * 100)
            : 100;
        return (
          <div key={stage.stage} className="flex items-center gap-3">
            <div
              className="w-36 text-sm font-medium truncate"
              title={STAGE_LABELS[stage.stage] || stage.label}
            >
              {STAGE_LABELS[stage.stage] || stage.label}
            </div>
            <div className="flex-1 bg-muted rounded-full h-6 relative overflow-hidden">
              <div
                className={`${STAGE_COLORS[idx] || "bg-blue-500"} h-6 rounded-full transition-all flex items-center justify-end pr-2`}
                style={{ width: `${Math.max(pct, 5)}%` }}
              >
                <span className="text-xs font-bold text-white drop-shadow">{stage.count}</span>
              </div>
            </div>
            {idx > 0 && (
              <div className="w-14 text-right text-xs text-muted-foreground">{convRate}%</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const OperationalDashboard: React.FC = () => {
  const { t } = useTranslation();
  // Operational metrics state
  const [metrics, setMetrics] = useState<OperationalMetric[]>([]);
  const [breakdowns, setBreakdowns] = useState<Breakdowns>({
    byAction: [],
    bySource: [],
    byResource: [],
  });
  const [resolvedGranularity, setResolvedGranularity] = useState<string>("daily");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("month");
  const [granularity, setGranularity] = useState<Granularity>("auto");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [chartType, setChartType] = useState<ChartType>("area");
  const [filters, setFilters] = useState<ActiveFilters>({});

  // Business analytics state
  const [funnel, setFunnel] = useState<FunnelStage[]>([]);
  const [registrationTrend, setRegistrationTrend] = useState<
    Array<{ date: string; value: number }>
  >([]);
  const [topWorkflows, setTopWorkflows] = useState<TopWorkflow[]>([]);
  const [engagement, setEngagement] = useState<EngagementData | null>(null);

  const loadMetrics = useCallback(async () => {
    try {
      const activeFilters = Object.fromEntries(
        Object.entries(filters).filter(([, v]) => v && v !== "all"),
      ) as { action?: string; source?: string; resource?: string };

      // Load all data in parallel
      const [operationalData, funnelData, topWfData, engagementData] = await Promise.all([
        apiClient.getOperationalMetrics(
          timeRange,
          granularity,
          Object.keys(activeFilters).length > 0 ? activeFilters : undefined,
        ),
        apiClient.getConversionFunnel(timeRange).catch(() => null),
        apiClient.getAnalyticsTopWorkflows(timeRange, 10).catch(() => null),
        apiClient.getEngagementMetrics(timeRange).catch(() => null),
      ]);

      setMetrics(operationalData.metrics);
      setBreakdowns(operationalData.breakdowns);
      setResolvedGranularity(operationalData.granularity);

      if (funnelData) {
        setFunnel(funnelData.funnel);
        setRegistrationTrend(funnelData.registrationTrend);
      }
      if (topWfData) {
        setTopWorkflows(topWfData.workflows);
      }
      if (engagementData) {
        setEngagement(engagementData);
      }

      setLastUpdated(new Date());
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [timeRange, granularity, filters, t]);

  useEffect(() => {
    setLoading(true);
    loadMetrics();
  }, [loadMetrics]);

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(loadMetrics, 15000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoRefresh, loadMetrics]);

  if (loading && metrics.length === 0) {
    return <PageShell title={t("admin.operational.title")} loading />;
  }

  if (error && metrics.length === 0) {
    return <PageShell title={t("admin.operational.title")} error={error} onRetry={loadMetrics} />;
  }

  return (
    <PageShell title={t("admin.operational.title")}>
      {/* Controls */}
      <div className="flex flex-wrap justify-between items-center gap-4 mb-6">
        <div className="flex items-center gap-3">
          <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
            <SelectTrigger className="w-[180px]" data-testid="time-range-selector">
              <SelectValue placeholder={t("admin.analytics.selectTimeRange")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">{t("admin.analytics.timeRanges.today")}</SelectItem>
              <SelectItem value="week">{t("admin.analytics.timeRanges.week")}</SelectItem>
              <SelectItem value="month">{t("admin.analytics.timeRanges.month")}</SelectItem>
              <SelectItem value="year">{t("admin.analytics.timeRanges.year")}</SelectItem>
              <SelectItem value="all">{t("admin.analytics.timeRanges.all")}</SelectItem>
            </SelectContent>
          </Select>

          <Select value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
            <SelectTrigger className="w-[150px]" data-testid="granularity-selector">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" /> {t("admin.operational.granularity.auto")}
                </span>
              </SelectItem>
              <SelectItem value="hourly">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" /> {t("admin.operational.granularity.hourly")}
                </span>
              </SelectItem>
              <SelectItem value="daily">
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> {t("admin.operational.granularity.daily")}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>

          <Button
            variant={autoRefresh ? "default" : "outline"}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
            data-testid="auto-refresh-toggle"
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${autoRefresh ? "animate-spin" : ""}`} />
            {autoRefresh
              ? t("admin.operational.autoRefreshOn")
              : t("admin.operational.autoRefreshOff")}
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Badge variant="outline" data-testid="granularity-badge">
            {resolvedGranularity === "hourly"
              ? `⏱ ${t("admin.operational.granularity.hourly")}`
              : `📅 ${t("admin.operational.granularity.daily")}`}
          </Badge>
          {lastUpdated && (
            <span className="text-sm text-muted-foreground" data-testid="last-updated">
              {t("admin.operational.lastUpdated", {
                time: lastUpdated.toLocaleTimeString(),
              })}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={loadMetrics} data-testid="refresh-button">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Filters & Chart Type */}
      <div className="flex flex-wrap items-center gap-3 mb-6" data-testid="filters-section">
        <Filter className="h-4 w-4 text-muted-foreground" />

        <Select
          value={filters.action || "all"}
          onValueChange={(v) =>
            setFilters((prev) => ({ ...prev, action: v === "all" ? undefined : v }))
          }
        >
          <SelectTrigger className="w-[150px]" data-testid="filter-action">
            <SelectValue placeholder={t("admin.operational.filters.action")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("admin.operational.filters.allActions")}</SelectItem>
            {breakdowns.byAction.map((item) => (
              <SelectItem key={item.label} value={item.label}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.source || "all"}
          onValueChange={(v) =>
            setFilters((prev) => ({ ...prev, source: v === "all" ? undefined : v }))
          }
        >
          <SelectTrigger className="w-[150px]" data-testid="filter-source">
            <SelectValue placeholder={t("admin.operational.filters.source")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("admin.operational.filters.allSources")}</SelectItem>
            {breakdowns.bySource.map((item) => (
              <SelectItem key={item.label} value={item.label}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.resource || "all"}
          onValueChange={(v) =>
            setFilters((prev) => ({ ...prev, resource: v === "all" ? undefined : v }))
          }
        >
          <SelectTrigger className="w-[150px]" data-testid="filter-resource">
            <SelectValue placeholder={t("admin.operational.filters.resource")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("admin.operational.filters.allResources")}</SelectItem>
            {breakdowns.byResource.map((item) => (
              <SelectItem key={item.label} value={item.label}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {(filters.action || filters.source || filters.resource) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters({})}
            data-testid="clear-filters"
          >
            {t("admin.operational.filters.clear")}
          </Button>
        )}

        <div className="ml-auto flex items-center gap-1" data-testid="chart-type-toggle">
          <Button
            variant={chartType === "area" ? "default" : "outline"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setChartType("area")}
            title={t("admin.operational.chartType.area")}
            data-testid="chart-type-area"
          >
            <AreaChartIcon className="h-4 w-4" />
          </Button>
          <Button
            variant={chartType === "line" ? "default" : "outline"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setChartType("line")}
            title={t("admin.operational.chartType.line")}
            data-testid="chart-type-line"
          >
            <LineChartIcon className="h-4 w-4" />
          </Button>
          <Button
            variant={chartType === "bar" ? "default" : "outline"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setChartType("bar")}
            title={t("admin.operational.chartType.bar")}
            data-testid="chart-type-bar"
          >
            <BarChart2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* === Business Analytics Section === */}
      <div className="mb-8">
        <h2
          className="text-xl font-bold mb-4 flex items-center gap-2"
          data-testid="business-analytics-heading"
        >
          <TrendingUp className="h-5 w-5" />
          {t("admin.businessAnalytics.title")}
        </h2>

        {/* Engagement Summary Cards */}
        {engagement && (
          <div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6"
            data-testid="engagement-cards"
          >
            <StatCard
              label={t("admin.businessAnalytics.engagement.returningUsers")}
              value={`${engagement.returningUsersRate}%`}
              icon={UserCheck}
              trend={
                engagement.activeUsersTrend.length > 1
                  ? engagement.activeUsersTrend.map((p) => p.value)
                  : undefined
              }
            />
            <StatCard
              label={t("admin.businessAnalytics.engagement.avgExecutionsPerUser")}
              value={engagement.avgExecutionsPerUser}
              icon={BarChart3}
            />
            <StatCard
              label={t("admin.businessAnalytics.engagement.timeToFirstWorkflow")}
              value={
                engagement.avgTimeToFirstWorkflowDays !== null
                  ? `${engagement.avgTimeToFirstWorkflowDays} ${t("admin.businessAnalytics.engagement.days")}`
                  : "—"
              }
              icon={Target}
            />
            <StatCard
              label={t("admin.analytics.userActivity.activeUsers")}
              value={engagement.totalActiveUsers}
              icon={Users}
            />
          </div>
        )}

        {/* Funnel + Top Workflows side by side */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Conversion Funnel */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Target className="h-4 w-4" />
                {t("admin.businessAnalytics.conversionFunnel.title")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {funnel.length > 0 ? (
                <ConversionFunnel funnel={funnel} testId="conversion-funnel" />
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  {t("admin.businessAnalytics.engagement.noData")}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Top Workflows */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                {t("admin.businessAnalytics.topWorkflows.title")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {topWorkflows.length > 0 ? (
                <div data-testid="top-workflows-chart">
                  <BarChart
                    className="h-56"
                    data={topWorkflows.slice(0, 8).map((wf) => ({
                      name:
                        wf.workflowName.length > 25
                          ? wf.workflowName.slice(0, 18) + "..."
                          : wf.workflowName,
                      [t("admin.businessAnalytics.topWorkflows.executions")]: wf.executionCount,
                    }))}
                    index="name"
                    categories={[t("admin.businessAnalytics.topWorkflows.executions")]}
                    colors={["indigo"]}
                    showLegend={false}
                    showAnimation
                    layout="vertical"
                    yAxisWidth={180}
                    valueFormatter={(v: number) => String(v)}
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  {t("admin.businessAnalytics.topWorkflows.noData")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Registration Trend + Active Users Trend */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {registrationTrend.length > 1 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  {t("admin.businessAnalytics.conversionFunnel.registrationTrend")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TimeSeriesChart
                  data={registrationTrend}
                  granularity="daily"
                  metricName={t("admin.businessAnalytics.conversionFunnel.registered")}
                  testId="chart-registration-trend"
                  chartType={chartType}
                />
              </CardContent>
            </Card>
          )}

          {engagement && engagement.activeUsersTrend.length > 1 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  {t("admin.businessAnalytics.engagement.activeUsersTrend")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <TimeSeriesChart
                  data={engagement.activeUsersTrend}
                  granularity="daily"
                  metricName={t("admin.businessAnalytics.engagement.activeUsersTrend")}
                  testId="chart-active-users-trend"
                  chartType={chartType}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* === Operational Metrics Section === */}
      <h2
        className="text-xl font-bold mb-4 flex items-center gap-2"
        data-testid="operational-heading"
      >
        <Activity className="h-5 w-5" />
        {t("admin.operational.title")}
      </h2>

      {/* Metrics Grid — summary cards */}
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8"
        data-testid="metrics-grid"
      >
        {metrics.map((metric) => {
          const Icon = METRIC_ICONS[metric.name];
          const trendValues = (metric.timeSeries ?? []).map((p) => p.value);

          if (!metric.available) {
            return (
              <Card key={metric.name} className="opacity-60" data-testid={`metric-${metric.name}`}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {t(`admin.operational.metrics.${metric.name}`)}
                  </CardTitle>
                  {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
                </CardHeader>
                <CardContent>
                  <Badge variant="outline">{t("admin.operational.unavailable")}</Badge>
                  <p className="text-xs text-muted-foreground mt-2">{metric.unit}</p>
                </CardContent>
              </Card>
            );
          }

          return (
            <StatCard
              key={metric.name}
              label={t(`admin.operational.metrics.${metric.name}`)}
              value={formatMetricValue(metric.name, metric.value)}
              icon={Icon}
              trend={trendValues.length > 1 ? trendValues : undefined}
            />
          );
        })}
      </div>

      {/* Time Series Charts — detailed view per metric */}
      {metrics.filter((m) => m.available && m.timeSeries.length > 1).length > 0 && (
        <div className="mb-8">
          <h3 className="text-lg font-semibold mb-4" data-testid="time-series-heading">
            {t("admin.operational.timeSeriesTitle")}
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" data-testid="time-series-section">
            {metrics
              .filter((m) => m.available && m.timeSeries.length > 1)
              .map((metric) => (
                <Card key={`ts-${metric.name}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">
                      {t(`admin.operational.metrics.${metric.name}`)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <TimeSeriesChart
                      data={metric.timeSeries}
                      granularity={resolvedGranularity}
                      metricName={t(`admin.operational.metrics.${metric.name}`)}
                      testId={`chart-${metric.name}`}
                      chartType={chartType}
                    />
                  </CardContent>
                </Card>
              ))}
          </div>
        </div>
      )}

      {/* Multi-Series Comparison — overlay related metrics */}
      {(() => {
        const started = metrics.find((m) => m.name === "workflows_started_per_day");
        const completed = metrics.find((m) => m.name === "workflows_completed_per_day");
        const hasWorkflowComparison =
          started?.available &&
          completed?.available &&
          (started.timeSeries?.length ?? 0) > 1 &&
          (completed.timeSeries?.length ?? 0) > 1;

        const callsRate = metrics.find((m) => m.name === "calls_per_second");
        const mcpRate = metrics.find((m) => m.name === "mcp_calls_per_second");
        const hasRateComparison =
          callsRate?.available &&
          mcpRate?.available &&
          (callsRate.timeSeries?.length ?? 0) > 1 &&
          (mcpRate.timeSeries?.length ?? 0) > 1;

        if (!hasWorkflowComparison && !hasRateComparison) return null;

        return (
          <div className="mb-8" data-testid="multi-series-section">
            <h3 className="text-lg font-semibold mb-4">
              {t("admin.operational.multiSeriesTitle")}
            </h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {hasWorkflowComparison && started && completed && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">
                      {t("admin.operational.multiSeries.workflowComparison")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <MultiSeriesChart
                      series={[
                        {
                          name: t("admin.operational.metrics.workflows_started_per_day"),
                          data: started.timeSeries,
                        },
                        {
                          name: t("admin.operational.metrics.workflows_completed_per_day"),
                          data: completed.timeSeries,
                        },
                      ]}
                      granularity={resolvedGranularity}
                      chartType={chartType}
                      testId="chart-workflow-comparison"
                    />
                  </CardContent>
                </Card>
              )}
              {hasRateComparison && callsRate && mcpRate && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">
                      {t("admin.operational.multiSeries.rateComparison")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <MultiSeriesChart
                      series={[
                        {
                          name: t("admin.operational.metrics.calls_per_second"),
                          data: callsRate.timeSeries,
                        },
                        {
                          name: t("admin.operational.metrics.mcp_calls_per_second"),
                          data: mcpRate.timeSeries,
                        },
                      ]}
                      granularity={resolvedGranularity}
                      chartType={chartType}
                      testId="chart-rate-comparison"
                    />
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        );
      })()}

      {/* Breakdowns — action types, sources, resources */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6" data-testid="breakdowns-section">
        {/* By Action */}
        {breakdowns.byAction.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {t("admin.operational.breakdowns.byAction")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BreakdownTable items={breakdowns.byAction} testId="breakdown-actions" />
            </CardContent>
          </Card>
        )}

        {/* By Source */}
        {breakdowns.bySource.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {t("admin.operational.breakdowns.bySource")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BreakdownTable items={breakdowns.bySource} testId="breakdown-sources" />
            </CardContent>
          </Card>
        )}

        {/* By Resource */}
        {breakdowns.byResource.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {t("admin.operational.breakdowns.byResource")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <BreakdownTable items={breakdowns.byResource} testId="breakdown-resources" />
            </CardContent>
          </Card>
        )}
      </div>
    </PageShell>
  );
};
