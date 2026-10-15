import { codespaceConnectionEventsTotal, codespaceRejectionsTotal } from "../metrics/index.js";
import type { CodespaceConnectionAuditEvent } from "./connection-service.js";
import type { CodespaceReadinessView } from "./views.js";
import { LOCAL_CODESPACE_FAILURE_GUIDANCE } from "./local-failure-guidance.js";

export function recordCodespaceConnectionEvent(event: CodespaceConnectionAuditEvent): void {
  codespaceConnectionEventsTotal.inc({ provider: event.provider, action: event.action });
}
const refusalCodes = new Set([
  "CODESPACE_PROVIDER_DISABLED",
  "CODESPACE_PROVIDER_UNAVAILABLE",
  "CODESPACE_AUTHORIZATION_REQUIRED",
  "CODESPACE_NOT_RUNNING",
  "CODESPACE_GENERATION_CONFLICT",
  "CODESPACE_REQUEST_INVALID",
]);
export function recordCodespaceRejection(code: string): void {
  if (refusalCodes.has(code) || Object.hasOwn(LOCAL_CODESPACE_FAILURE_GUIDANCE, code))
    codespaceRejectionsTotal.inc({ code });
}
export interface CodespaceObservabilityDependencies {
  providerId: string;
  config: () =>
    { state: "available" } | { state: "disabled" } | { state: "invalid"; reason: string };
  policy: () => { enabled: boolean };
  now?: () => number;
}
/** Configuration metadata only; live resource observations belong to the provider and owner. */
export class CodespaceObservabilityService {
  constructor(private readonly dependencies: CodespaceObservabilityDependencies) {}
  async readiness(): Promise<CodespaceReadinessView> {
    const config = this.dependencies.config(),
      enabled = this.dependencies.policy().enabled;
    return {
      state:
        config.state === "invalid"
          ? "misconfigured"
          : !enabled || config.state === "disabled"
            ? "disabled"
            : "ready",
      reason: config.state === "invalid" ? config.reason : null,
      provider: this.dependencies.providerId,
      configuration:
        config.state === "available"
          ? "available"
          : config.state === "invalid"
            ? "invalid"
            : "absent",
      resources_enabled: enabled,
      checked_at: (this.dependencies.now ?? Date.now)(),
    };
  }
  async snapshot() {
    return this.readiness();
  }
}
