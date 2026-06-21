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
import { apiClient } from "../services/api-client";

interface TestEvent {
  id: string;
  type: string;
  status: "success" | "error" | "pending";
  message: string;
  timestamp: Date;
  details?: string;
}

export const AdminMonitoringTest: React.FC = () => {
  const { t } = useTranslation();
  const [events, setEvents] = useState<TestEvent[]>([]);
  const [isLoading, setIsLoading] = useState<Record<string, boolean>>({});

  const addEvent = (
    type: string,
    status: TestEvent["status"],
    message: string,
    details?: string,
  ) => {
    const event: TestEvent = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      status,
      message,
      timestamp: new Date(),
      details,
    };
    setEvents((prev) => [event, ...prev].slice(0, 20)); // Keep last 20 events
  };

  const setLoading = (key: string, value: boolean) => {
    setIsLoading((prev) => ({ ...prev, [key]: value }));
  };

  // Frontend error triggers
  const triggerReactError = () => {
    addEvent("react-error", "pending", "Triggering React error...");
    // This will be caught by ErrorBoundary
    throw new Error("Test React error (ErrorBoundary) - Monitoring Test");
  };

  const triggerWindowError = () => {
    addEvent("window-error", "success", "Window error triggered (check console)");
    setTimeout(() => {
      throw new Error("Test window.onerror - Monitoring Test");
    }, 0);
  };

  const triggerPromiseError = () => {
    addEvent("promise-error", "success", "Promise rejection triggered (check console)");
    Promise.reject(new Error("Test unhandledrejection - Monitoring Test"));
  };

  // Backend error triggers
  const triggerApiError = async () => {
    setLoading("api-error", true);
    try {
      addEvent("api-error", "pending", "Triggering API error...");
      await apiClient.triggerMonitoringTestError("Test error from Monitoring Test page");
      // If we get here, something is wrong (should have returned 500)
      addEvent("api-error", "error", "Expected 500 error but got success");
    } catch (error) {
      addEvent(
        "api-error",
        "success",
        "API error triggered successfully (500)",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      setLoading("api-error", false);
    }
  };

  const triggerSlowRequest = async () => {
    const delayMs = 3000;
    setLoading("slow-request", true);
    addEvent("slow-request", "pending", `Triggering slow request (${delayMs}ms)...`);
    try {
      const startTime = Date.now();
      await apiClient.triggerMonitoringTestSlowRequest(delayMs);
      const duration = Date.now() - startTime;
      addEvent("slow-request", "success", `Slow request completed in ${duration}ms`);
    } catch (error) {
      addEvent(
        "slow-request",
        "error",
        "Slow request failed",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      setLoading("slow-request", false);
    }
  };

  const triggerLogLevels = async () => {
    setLoading("log-levels", true);
    addEvent("log-levels", "pending", "Generating logs at all levels...");
    try {
      const data = await apiClient.triggerMonitoringTestLogLevels([
        "debug",
        "info",
        "warn",
        "error",
      ]);
      addEvent(
        "log-levels",
        "success",
        `Generated ${data?.generatedLogs?.length || 0} log entries`,
        `Levels: ${data?.generatedLogs?.join(", ") || "unknown"}`,
      );
    } catch (error) {
      addEvent(
        "log-levels",
        "error",
        "Failed to generate logs",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      setLoading("log-levels", false);
    }
  };

  const triggerWorkflowExecution = async () => {
    setLoading("workflow", true);
    addEvent("workflow", "pending", "Triggering workflow execution...");
    try {
      const data = await apiClient.triggerMonitoringTestWorkflow("monitoring-test-workflow");
      addEvent("workflow", "success", data.message, data.suggestion);
    } catch (error) {
      addEvent(
        "workflow",
        "error",
        "Failed to trigger workflow",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      setLoading("workflow", false);
    }
  };

  const triggerMcpCall = async (status: "success" | "error" = "success") => {
    const key = `mcp-call-${status}`;
    setLoading(key, true);
    addEvent("mcp-call", "pending", `Simulating MCP tool call (${status})...`);
    try {
      const data = await apiClient.triggerMonitoringTestMcpCall("list_workflows", status);
      addEvent("mcp-call", "success", data.message, `Execution time: ${data.executionTimeMs}ms`);
    } catch (error) {
      addEvent(
        "mcp-call",
        "error",
        "Failed to simulate MCP call",
        error instanceof Error ? error.message : "Unknown error",
      );
    } finally {
      setLoading(key, false);
    }
  };

  const clearEvents = () => {
    setEvents([]);
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold mb-2 text-foreground">{t("admin.monitoringTest.title")}</h1>
      <p className="text-muted-foreground mb-6">{t("admin.monitoringTest.description")}</p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Frontend Errors Section */}
        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4 text-foreground">
            {t("admin.monitoringTest.frontendErrors.title")}
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            {t("admin.monitoringTest.frontendErrors.description")}
          </p>

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
        </div>

        {/* Backend Errors Section */}
        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4 text-foreground">
            {t("admin.monitoringTest.backendErrors.title")}
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            {t("admin.monitoringTest.backendErrors.description")}
          </p>

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
        </div>
      </div>

      {/* Workflow & MCP Section */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Workflow Execution Section */}
        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4 text-foreground">
            {t("admin.monitoringTest.workflowTest.title")}
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            {t("admin.monitoringTest.workflowTest.description")}
          </p>

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
        </div>

        {/* MCP Tool Call Section */}
        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <h2 className="text-xl font-semibold mb-4 text-foreground">
            {t("admin.monitoringTest.mcpTest.title")}
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            {t("admin.monitoringTest.mcpTest.description")}
          </p>

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
        </div>
      </div>

      {/* Events History Section */}
      <div className="mt-6 bg-card border border-border rounded-lg p-6 shadow-sm">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-foreground">
            {t("admin.monitoringTest.eventHistory.title")}
          </h2>
          <Button onClick={clearEvents} variant="secondary" size="sm">
            {t("admin.monitoringTest.eventHistory.clear")}
          </Button>
        </div>

        {events.length === 0 ? (
          <p className="text-muted-foreground text-center py-4">
            {t("admin.monitoringTest.eventHistory.empty")}
          </p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
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
                    <span className="ml-2 text-sm text-muted-foreground">{event.message}</span>
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
          </div>
        )}
      </div>

      {/* Verification Commands Section */}
      <div className="mt-6 bg-muted rounded-lg p-6">
        <h2 className="font-semibold mb-4 text-foreground">
          {t("admin.monitoringTest.verification.title")}
        </h2>
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">
              {t("admin.monitoringTest.verification.dockerLogs")}
            </h3>
            <pre className="text-sm text-muted-foreground bg-card p-2 rounded overflow-x-auto">
              {'docker logs mcp-moira-dev2 2>&1 | grep "MonitoringTest"'}
            </pre>
          </div>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">
              {t("admin.monitoringTest.verification.metricsEndpoint")}
            </h3>
            <pre className="text-sm text-muted-foreground bg-card p-2 rounded overflow-x-auto">
              curl localhost:9090/metrics | grep http_request
            </pre>
          </div>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-1">
              {t("admin.monitoringTest.verification.clientLogs")}
            </h3>
            <pre className="text-sm text-muted-foreground bg-card p-2 rounded overflow-x-auto">
              {'docker logs mcp-moira-dev2 2>&1 | grep "client_log"'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};
