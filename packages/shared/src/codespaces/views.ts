import type {
  CodespaceResourceErrorCode,
  CodespaceResourceState,
  CodespaceDesiredState,
  CodespaceObservedState,
  CodespaceRetentionPolicy,
} from "./resource-types.js";

/**
 * Sanitized codespace summary shared by the website and the MCP tools. It omits
 * connection and authorization generations, external owner/billing identifiers, the
 * operation marker, the provider resource name, claims and lifecycle capabilities.
 */
export interface CodespaceSummaryView {
  codespace_id: string;
  provider: string;
  repository_id: string;
  repository: string;
  /** The ref the codespace was created on. */
  requested_ref: string;
  /**
   * The ref the provider last reported checked out, which changes when an agent switches branches;
   * `null` until Moira has observed it or while the codespace is on a detached HEAD.
   */
  current_ref: string | null;
  machine: {
    name: string;
    display_name: string;
    operating_system: string;
    cpu_cores: number;
    memory_bytes: number;
    storage_bytes: number;
  } | null;
  state: CodespaceResourceState;
  retention_policy: CodespaceRetentionPolicy;
  desired_state: CodespaceDesiredState;
  observed_state: CodespaceObservedState;
  /** Null until an exact provider observation succeeds; retries do not advance it. */
  observed_at: number | null;
  lifecycle_error: CodespaceResourceErrorCode | null;
  generation: number;
  created_at: number;
  updated_at: number;
  pending_request_ids?: string[];
  device_id?: string;
  provider_url?: string;
}

/** GitHub's monthly bill for the connected personal account, separate from Moira's own limits. */
export interface CodespaceAvailableBillingView {
  state: "available";
  payer_login: string;
  period: { year: number; month: number };
  /** When Moira retrieved the summary; GitHub's usage data may lag this time. */
  retrieved_at: number;
  plan: "free" | "pro" | null;
  compute: {
    used_core_hours: number;
    included_core_hours: number | null;
    net_amount_usd: number;
  };
  storage: {
    used_gb_month: number;
    included_gb_month: number | null;
    net_amount_usd: number;
  };
  net_amount_usd: number;
}

export type CodespaceProviderBillingView = "unavailable" | CodespaceAvailableBillingView;

/** Disabled configuration is healthy; invalid configuration degrades the instance. */
export function isCodespaceReadinessDegraded(
  readiness: Pick<CodespaceReadinessView, "state">,
): boolean {
  return readiness.state === "misconfigured";
}

/**
 * What unauthenticated liveness surfaces may reveal: the readiness state, the
 * provider and whether configuration degrades the instance.
 */
export interface CodespacePublicReadinessView {
  state: CodespaceReadinessState;
  provider: string;
  degraded: boolean;
}

export function projectPublicCodespaceReadiness(
  readiness: Pick<CodespaceReadinessView, "state" | "provider">,
): CodespacePublicReadinessView {
  return {
    state: readiness.state,
    provider: readiness.provider,
    degraded: isCodespaceReadinessDegraded(readiness),
  };
}

export type CodespaceReadinessState = "disabled" | "misconfigured" | "ready";

/**
 * One instance-level readiness decision shared by the website, administration,
 * backend health and MCP surfaces. It contains no user, codespace or operation
 * identifiers.
 */
export interface CodespaceReadinessView {
  state: CodespaceReadinessState;
  reason: string | null;
  provider: string;
  configuration: "absent" | "invalid" | "available";
  resources_enabled: boolean;
  checked_at: number;
}
