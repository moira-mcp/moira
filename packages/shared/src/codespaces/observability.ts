import {
  codespaceActiveGauge,
  codespaceConnectionEventsTotal,
  codespaceConnectorAvailableGauge,
  codespaceLifecycleEventsTotal,
  codespaceOperationDurationSeconds,
  codespaceOperationEventsTotal,
  codespaceReadyGauge,
  codespaceReconciliationDueGauge,
  codespaceReconciliationOldestDueAgeSeconds,
  codespaceRejectionsTotal,
  codespaceTransferLiveBytesGauge,
} from "../metrics/index.js";
import type { CodespaceConnectionAuditEvent } from "./connection-service.js";
import type { CodespaceGitHubConfigStatus } from "./github-app-config.js";
import type { CodespaceOperationRepository } from "./operation-repository.js";
import type { CodespaceOperationAuditEvent } from "./operation-service.js";
import type { CodespaceResourceRepository } from "./resource-repository.js";
import type { CodespaceResourceAuditEvent } from "./resource-service.js";
import type {
  CodespaceResourceErrorCode,
  CodespaceResourcePolicy,
  CodespaceTransportAvailability,
} from "./resource-types.js";
import type { CodespaceTransferRepository } from "./transfer-repository.js";
import type { CodespaceReadinessView } from "./views.js";

const TERMINAL_OPERATION_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

/** Count a provider connection audit event (start/complete/refresh_failed/disconnect). */
export function recordCodespaceConnectionEvent(event: CodespaceConnectionAuditEvent): void {
  codespaceConnectionEventsTotal.inc({ provider: event.provider, action: event.action });
}

/** Count a codespace lifecycle audit event with closed labels only. */
export function recordCodespaceResourceEvent(event: CodespaceResourceAuditEvent): void {
  codespaceLifecycleEventsTotal.inc({
    provider: event.provider,
    action: event.action,
    state: event.state,
  });
}

/**
 * Count a codespace operation audit event and, for terminal outcomes, observe the
 * reservation-to-terminal duration.
 */
export function recordCodespaceOperationEvent(
  event: CodespaceOperationAuditEvent,
  durationMs?: number,
): void {
  codespaceOperationEventsTotal.inc({
    provider: event.provider,
    kind: event.kind,
    action: event.action,
    state: event.state,
  });
  if (event.action === "terminal" && TERMINAL_OPERATION_STATES.has(event.state)) {
    if (durationMs !== undefined && durationMs >= 0) {
      codespaceOperationDurationSeconds.observe(
        { kind: event.kind, state: event.state },
        durationMs / 1000,
      );
    }
  }
}

/** Resource error codes plus the MCP-layer schema refusal, all bounded pre-provider labels. */
const REJECTION_CODES: ReadonlySet<string> = new Set<
  CodespaceResourceErrorCode | "CODESPACE_REQUEST_INVALID"
>([
  "CODESPACE_PROVIDER_DISABLED",
  "CODESPACE_PROVIDER_UNAVAILABLE",
  "CODESPACE_POLICY_LIMIT",
  "CODESPACE_SESSION_UNAVAILABLE",
  "CODESPACE_OPERATION_BUSY",
  "CODESPACE_AUTHORIZATION_REQUIRED",
  "CODESPACE_NOT_RUNNING",
  "CODESPACE_START_TIMEOUT",
  "CODESPACE_GENERATION_CONFLICT",
  "CODESPACE_REQUEST_INVALID",
]);

/** Count a bounded pre-provider refusal. Unknown codes are ignored to keep labels closed. */
export function recordCodespaceRejection(code: string): void {
  if (REJECTION_CODES.has(code)) codespaceRejectionsTotal.inc({ code });
}

export interface CodespaceObservabilityDependencies {
  providerId: string;
  config: () => CodespaceGitHubConfigStatus;
  policy: () => CodespaceResourcePolicy;
  resources: Pick<CodespaceResourceRepository, "listControls" | "countActive" | "dueSummary">;
  operations: Pick<CodespaceOperationRepository, "countActive" | "dueSummary">;
  transfers: Pick<CodespaceTransferRepository, "listLive">;
  /** Present only when the provider composition exists; absent while configuration is missing. */
  transport: CodespaceTransportAvailability | null;
  now?: () => number;
  /** Upper bound for one connector health probe; a slower probe counts as unavailable. */
  probeTimeoutMs?: number;
  /** How old a cached decision may be before `snapshot()` recomputes it. */
  snapshotMaxAgeMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_SNAPSHOT_MAX_AGE_MS = 60_000;

/**
 * Computes the single instance-level readiness decision and projects it into the
 * Prometheus gauges. Every surface (website, administration, backend health, MCP)
 * consumes this object rather than re-deriving readiness.
 */
export class CodespaceObservabilityService {
  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private last: CodespaceReadinessView | null = null;
  private inFlight: Promise<CodespaceReadinessView> | null = null;

  constructor(private readonly dependencies: CodespaceObservabilityDependencies) {}

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }

  /**
   * The decision for liveness surfaces: the last computed view while it is younger
   * than `snapshotMaxAgeMs`, otherwise one shared recomputation. A public health
   * request therefore never waits on a stalled connector beyond the bounded probe,
   * and concurrent requests share one computation.
   */
  async snapshot(): Promise<CodespaceReadinessView> {
    const maxAge = this.dependencies.snapshotMaxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS;
    if (this.last && this.now() - this.last.checked_at <= maxAge) return this.last;
    if (!this.inFlight) {
      this.inFlight = this.readiness().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async probeConnector(
    transport: CodespaceTransportAvailability,
  ): Promise<CodespaceReadinessView["connector"]> {
    const timeoutMs = this.dependencies.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<CodespaceReadinessView["connector"]>((resolve) => {
      timer = setTimeout(
        () => resolve({ state: "unavailable", reason: "health_probe_timeout" }),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([
        transport.health().then(
          (health): CodespaceReadinessView["connector"] =>
            health.ok
              ? { state: "available", reason: null }
              : { state: "unavailable", reason: health.reason },
          (): CodespaceReadinessView["connector"] => ({
            state: "unavailable",
            reason: "health_probe_failed",
          }),
        ),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async readiness(): Promise<CodespaceReadinessView> {
    const now = this.now();
    const provider = this.dependencies.providerId;
    const config = this.dependencies.config();
    const policy = this.dependencies.policy();
    const controls = this.dependencies.resources.listControls(provider).map((control) => ({
      scope: control.scope,
      disabled: control.disabled,
      reason: control.reason,
      updated_at: control.updatedAt,
    }));
    const resourceDue = this.dependencies.resources.dueSummary(now);
    const operationDue = this.dependencies.operations.dueSummary(now);
    const oldest = [resourceDue.oldestUpdatedAt, operationDue.oldestUpdatedAt].filter(
      (value): value is number => value !== null,
    );
    const transferLiveBytes = this.dependencies.transfers
      .listLive()
      .reduce((sum, record) => sum + (record.observedSize ?? record.declaredSize), 0);

    let connector: CodespaceReadinessView["connector"] = {
      state: "not_applicable",
      reason: null,
    };
    if (config.state === "available" && policy.enabled && this.dependencies.transport) {
      connector = await this.probeConnector(this.dependencies.transport);
    }

    const disabledControl = controls.find((control) => control.disabled);
    let state: CodespaceReadinessView["state"];
    let reason: string | null;
    if (config.state === "invalid") {
      state = "misconfigured";
      reason = config.reason;
    } else if (config.state === "disabled" || !policy.enabled) {
      state = "disabled";
      reason = config.state === "disabled" ? "NOT_CONFIGURED" : "RESOURCES_DISABLED";
    } else if (disabledControl) {
      state = "control_disabled";
      reason = disabledControl.scope;
    } else if (connector.state === "unavailable") {
      state = "connector_unavailable";
      reason = connector.reason;
    } else {
      state = "ready";
      reason = null;
    }

    const view: CodespaceReadinessView = {
      state,
      reason,
      provider,
      configuration:
        config.state === "available"
          ? "available"
          : config.state === "invalid"
            ? "invalid"
            : "absent",
      resources_enabled: policy.enabled,
      controls,
      connector,
      reconciliation: {
        due_resources: resourceDue.count,
        due_operations: operationDue.count,
        oldest_due_age_ms: oldest.length > 0 ? Math.max(0, now - Math.min(...oldest)) : null,
      },
      usage: {
        active_resources: this.dependencies.resources.countActive(provider),
        max_active_resources: policy.maxActiveGlobal,
        active_operations: this.dependencies.operations.countActive(),
        max_active_operations: policy.maxConcurrentOperationsGlobal ?? null,
        transfer_live_bytes: transferLiveBytes,
        max_transfer_live_bytes: policy.maxTransferBytesGlobal ?? null,
      },
      checked_at: now,
    };
    this.project(view, resourceDue.oldestUpdatedAt, operationDue.oldestUpdatedAt);
    this.last = view;
    return view;
  }

  private project(
    view: CodespaceReadinessView,
    oldestResource: number | null,
    oldestOperation: number | null,
  ): void {
    const now = view.checked_at;
    codespaceReadyGauge.set({ provider: view.provider }, view.state === "ready" ? 1 : 0);
    codespaceConnectorAvailableGauge.set(
      { provider: view.provider },
      view.connector.state === "available" ? 1 : 0,
    );
    codespaceReconciliationDueGauge.set({ kind: "resource" }, view.reconciliation.due_resources);
    codespaceReconciliationDueGauge.set({ kind: "operation" }, view.reconciliation.due_operations);
    codespaceReconciliationOldestDueAgeSeconds.set(
      { kind: "resource" },
      oldestResource === null ? 0 : Math.max(0, now - oldestResource) / 1000,
    );
    codespaceReconciliationOldestDueAgeSeconds.set(
      { kind: "operation" },
      oldestOperation === null ? 0 : Math.max(0, now - oldestOperation) / 1000,
    );
    codespaceActiveGauge.set({ kind: "resource" }, view.usage.active_resources);
    codespaceActiveGauge.set({ kind: "operation" }, view.usage.active_operations);
    codespaceTransferLiveBytesGauge.set(view.usage.transfer_live_bytes);
  }

  /** Refresh the gauges periodically so `/metrics` stays current without a request. */
  start(intervalMs: number): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.readiness();
    } catch {
      // A failed refresh leaves the previous gauge values; the next request recomputes.
    } finally {
      this.refreshing = false;
    }
  }
}
