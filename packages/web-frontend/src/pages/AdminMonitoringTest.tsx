/**
 * Admin Monitoring Test Page
 * Comprehensive tool for testing and validating monitoring pipeline
 *
 * Features:
 * - Frontend error testing (React, window.onerror, Promise rejection)
 * - Backend error testing (500 responses, slow requests)
 * - Log level testing (debug, info, warn, error)
 * - Event history panel
 * - Verification commands
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { apiClient, ApiClientError } from "../services/api-client";
import { PageShell } from "@/components/PageShell";
import { SettingsSubsection } from "@/components/settings/SettingsSection";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/empty-state";
import { useReadOwnerGuard } from "@/auth/ReadScopeBoundary";
import { Activity } from "lucide-react";

interface TestEvent {
  id: string;
  type: string;
  status: "success" | "error" | "pending";
  message: string;
  timestamp: Date;
  details?: string;
  values?: Record<string, string | number>;
}

export const AdminMonitoringTest: React.FC = () => {
  const { t } = useTranslation();
  const [events, setEvents] = useState<TestEvent[]>([]);
  const [isLoading, setIsLoading] = useState<Record<string, boolean>>({});
  const guardOwner = useReadOwnerGuard();

  const addEvent = (
    type: string,
    status: TestEvent["status"],
    message: string,
    details?: string,
    values?: Record<string, string | number>,
  ) => {
    const event: TestEvent = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      status,
      message,
      timestamp: new Date(),
      details,
      values,
    };
    setEvents((prev) => [event, ...prev].slice(0, 20)); // Keep last 20 events
  };

  const setLoading = (key: string, value: boolean) => {
    setIsLoading((prev) => ({ ...prev, [key]: value }));
  };

  // Frontend error triggers
  const triggerReactError = () => {
    addEvent("react-error", "pending", "reactPending");
    throw new Error("Test React error (ErrorBoundary) - Monitoring Test");
  };

  const triggerWindowError = () => {
    addEvent("window-error", "success", "windowTriggered");
    setTimeout(() => {
      throw new Error("Test window.onerror - Monitoring Test");
    }, 0);
  };

  const triggerPromiseError = () => {
    addEvent("promise-error", "success", "promiseTriggered");
    Promise.reject(new Error("Test unhandledrejection - Monitoring Test"));
  };

  // Backend error triggers
  const triggerApiError = async () => {
    const isCurrent = guardOwner();
    const isMountedOwner = guardOwner(false);
    setLoading("api-error", true);
    try {
      addEvent("api-error", "pending", "apiPending");
      await apiClient.triggerMonitoringTestError("Test error from Monitoring Test page");
      // If we get here, something is wrong (should have returned 500)
      if (isCurrent()) addEvent("api-error", "error", "apiUnexpectedSuccess");
    } catch (error) {
      if (isCurrent())
        addEvent(
          "api-error",
          error instanceof ApiClientError &&
            error.status === 500 &&
            String(error.code) === "TEST_ERROR"
            ? "success"
            : "error",
          error instanceof ApiClientError &&
            error.status === 500 &&
            String(error.code) === "TEST_ERROR"
            ? "apiExpectedError"
            : "apiFailed",
          error instanceof Error ? error.message : undefined,
        );
    } finally {
      if (isMountedOwner()) setLoading("api-error", false);
    }
  };

  const triggerSlowRequest = async () => {
    const isCurrent = guardOwner();
    const isMountedOwner = guardOwner(false);
    const delayMs = 3000;
    setLoading("slow-request", true);
    addEvent("slow-request", "pending", "slowPending", undefined, { ms: delayMs });
    try {
      const startTime = Date.now();
      await apiClient.triggerMonitoringTestSlowRequest(delayMs);
      const duration = Date.now() - startTime;
      if (isCurrent())
        addEvent("slow-request", "success", "slowCompleted", undefined, { ms: duration });
    } catch (error) {
      if (isCurrent())
        addEvent(
          "slow-request",
          "error",
          "slowFailed",
          error instanceof Error ? error.message : undefined,
        );
    } finally {
      if (isMountedOwner()) setLoading("slow-request", false);
    }
  };

  const triggerLogLevels = async () => {
    const isCurrent = guardOwner();
    const isMountedOwner = guardOwner(false);
    setLoading("log-levels", true);
    addEvent("log-levels", "pending", "logsPending");
    try {
      const data = await apiClient.triggerMonitoringTestLogLevels([
        "debug",
        "info",
        "warn",
        "error",
      ]);
      if (isCurrent())
        addEvent("log-levels", "success", "logsCompleted", data.generatedLogs.join(", "), {
          count: data.generatedLogs.length,
        });
    } catch (error) {
      if (isCurrent())
        addEvent(
          "log-levels",
          "error",
          "logsFailed",
          error instanceof Error ? error.message : undefined,
        );
    } finally {
      if (isMountedOwner()) setLoading("log-levels", false);
    }
  };

  const triggerWorkflowExecution = async () => {
    const isCurrent = guardOwner();
    const isMountedOwner = guardOwner(false);
    setLoading("workflow", true);
    addEvent("workflow", "pending", "workflowPending");
    try {
      const data = await apiClient.triggerMonitoringTestWorkflow("monitoring-test-workflow");
      if (isCurrent())
        addEvent("workflow", "success", "workflowCompleted", `${data.message}\n${data.suggestion}`);
    } catch (error) {
      if (isCurrent())
        addEvent(
          "workflow",
          "error",
          "workflowFailed",
          error instanceof Error ? error.message : undefined,
        );
    } finally {
      if (isMountedOwner()) setLoading("workflow", false);
    }
  };

  const triggerMcpCall = async (status: "success" | "error" = "success") => {
    const isCurrent = guardOwner();
    const isMountedOwner = guardOwner(false);
    const key = `mcp-call-${status}`;
    setLoading(key, true);
    addEvent("mcp-call", "pending", "mcpPending");
    try {
      const data = await apiClient.triggerMonitoringTestMcpCall("list", status);
      if (isCurrent())
        addEvent(
          "mcp-call",
          "success",
          data.status === "error" ? "mcpCompletedError" : "mcpCompletedSuccess",
          data.message,
          { ms: data.executionTimeMs },
        );
    } catch (error) {
      if (isCurrent())
        addEvent(
          "mcp-call",
          "error",
          "mcpFailed",
          error instanceof Error ? error.message : undefined,
        );
    } finally {
      if (isMountedOwner()) setLoading(key, false);
    }
  };

  const clearEvents = () => {
    setEvents([]);
  };

  return (
    <PageShell
      title={t("admin.monitoringTest.title")}
      description={t("admin.monitoringTest.description")}
      className="p-6 md:p-8 space-y-6"
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Frontend Errors Section */}
        <SettingsSubsection
          headingLevel={2}
          title={t("admin.monitoringTest.frontendErrors.title")}
          description={t("admin.monitoringTest.frontendErrors.description")}
        >
          <div className="flex flex-col gap-3">
            <Button
              onClick={triggerReactError}
              data-testid="trigger-react-error"
              variant="destructive"
            >
              {t("admin.monitoringTest.frontendErrors.reactError")}
            </Button>
            <Button
              onClick={triggerWindowError}
              data-testid="trigger-window-error"
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              {t("admin.monitoringTest.frontendErrors.windowError")}
            </Button>
            <Button
              onClick={triggerPromiseError}
              data-testid="trigger-promise-error"
              className="bg-chart-4 text-primary-foreground hover:bg-chart-4/90"
            >
              {t("admin.monitoringTest.frontendErrors.promiseError")}
            </Button>
          </div>
        </SettingsSubsection>

        {/* Backend Errors Section */}
        <SettingsSubsection
          headingLevel={2}
          title={t("admin.monitoringTest.backendErrors.title")}
          description={t("admin.monitoringTest.backendErrors.description")}
        >
          <div className="flex flex-col gap-3">
            <Button
              onClick={triggerApiError}
              disabled={isLoading["api-error"]}
              data-testid="trigger-api-error"
              variant="destructive"
            >
              {isLoading["api-error"]
                ? t("admin.monitoringTest.loading")
                : t("admin.monitoringTest.backendErrors.apiError")}
            </Button>
            <Button
              onClick={triggerSlowRequest}
              disabled={isLoading["slow-request"]}
              data-testid="trigger-slow-request"
            >
              {isLoading["slow-request"]
                ? t("admin.monitoringTest.loading")
                : t("admin.monitoringTest.backendErrors.slowRequest")}
            </Button>
            <Button
              onClick={triggerLogLevels}
              disabled={isLoading["log-levels"]}
              data-testid="trigger-log-levels"
              className="bg-chart-3 text-primary-foreground hover:bg-chart-3/90"
            >
              {isLoading["log-levels"]
                ? t("admin.monitoringTest.loading")
                : t("admin.monitoringTest.backendErrors.logLevels")}
            </Button>
          </div>
        </SettingsSubsection>
      </div>

      {/* Workflow & MCP Section */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Workflow Execution Section */}
        <SettingsSubsection
          headingLevel={2}
          title={t("admin.monitoringTest.workflowTest.title")}
          description={t("admin.monitoringTest.workflowTest.description")}
        >
          <div className="flex flex-col gap-3">
            <Button
              onClick={triggerWorkflowExecution}
              disabled={isLoading["workflow"]}
              data-testid="trigger-workflow"
              className="bg-success text-success-foreground hover:bg-success/90"
            >
              {isLoading["workflow"]
                ? t("admin.monitoringTest.loading")
                : t("admin.monitoringTest.workflowTest.startWorkflow")}
            </Button>
          </div>
        </SettingsSubsection>

        {/* MCP Tool Call Section */}
        <SettingsSubsection
          headingLevel={2}
          title={t("admin.monitoringTest.mcpTest.title")}
          description={t("admin.monitoringTest.mcpTest.description")}
        >
          <div className="flex flex-col gap-3">
            <Button
              onClick={() => triggerMcpCall("success")}
              disabled={isLoading["mcp-call-success"]}
              data-testid="trigger-mcp-success"
              className="bg-chart-2 text-primary-foreground hover:bg-chart-2/90"
            >
              {isLoading["mcp-call-success"]
                ? t("admin.monitoringTest.loading")
                : t("admin.monitoringTest.mcpTest.successCall")}
            </Button>
            <Button
              onClick={() => triggerMcpCall("error")}
              disabled={isLoading["mcp-call-error"]}
              data-testid="trigger-mcp-error"
              variant="destructive"
            >
              {isLoading["mcp-call-error"]
                ? t("admin.monitoringTest.loading")
                : t("admin.monitoringTest.mcpTest.errorCall")}
            </Button>
          </div>
        </SettingsSubsection>
      </div>

      {/* Events History Section */}
      <SettingsSubsection
        headingLevel={2}
        title={t("admin.monitoringTest.eventHistory.title")}
        actions={
          <Button onClick={clearEvents} variant="secondary" size="sm">
            {t("admin.monitoringTest.eventHistory.clear")}
          </Button>
        }
      >
        {events.length === 0 ? (
          <EmptyState icon={Activity} title={t("admin.monitoringTest.eventHistory.empty")} />
        ) : (
          <ScrollArea
            className="space-y-2 max-h-64"
            tabIndex={0}
            aria-label={t("admin.monitoringTest.eventHistory.title")}
          >
            {events.map((event) => (
              <div
                key={event.id}
                className={`p-3 rounded-lg border ${
                  event.status === "success"
                    ? "bg-success/10 border-success/30"
                    : event.status === "error"
                      ? "bg-destructive/10 border-destructive/30"
                      : "bg-primary/10 border-primary/30"
                }`}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <span className="font-medium text-foreground">{event.type}</span>
                    <span className="ml-2 text-sm text-muted-foreground">
                      {t(`admin.monitoringTest.events.${event.message}`, event.values)}
                    </span>
                    {event.details && (
                      <p className="text-xs text-muted-foreground mt-1">{event.details}</p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {event.timestamp.toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))}
          </ScrollArea>
        )}
      </SettingsSubsection>

      {/* Verification Commands Section */}
      <SettingsSubsection headingLevel={2} title={t("admin.monitoringTest.verification.title")}>
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">
              {t("admin.monitoringTest.verification.dockerLogs")}
            </h3>
            <pre className="text-sm text-muted-foreground bg-card p-2 rounded overflow-x-auto">
              {'docker compose logs moira 2>&1 | grep "MonitoringTest"'}
            </pre>
          </div>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">
              {t("admin.monitoringTest.verification.metricsEndpoint")}
            </h3>
            <pre className="text-sm text-muted-foreground bg-card p-2 rounded overflow-x-auto">
              {
                "docker compose exec moira sh -c 'curl -fsS \"http://127.0.0.1:${METRICS_PORT:-9090}/metrics\" | grep http_request'"
              }
            </pre>
          </div>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">
              {t("admin.monitoringTest.verification.clientLogs")}
            </h3>
            <pre className="text-sm text-muted-foreground bg-card p-2 rounded overflow-x-auto">
              {'docker compose logs moira 2>&1 | grep "client_log"'}
            </pre>
          </div>
        </div>
      </SettingsSubsection>
    </PageShell>
  );
};
