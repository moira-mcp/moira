import { describe, expect, it } from "@jest/globals";
import {
  CodespaceObservabilityService,
  isCodespaceReadinessDegraded,
  metricsRegistry,
  projectPublicCodespaceReadiness,
  recordCodespaceConnectionEvent,
  recordCodespaceOperationEvent,
  recordCodespaceRejection,
  recordCodespaceResourceEvent,
  type CodespaceGitHubConfigStatus,
  type CodespaceObservabilityDependencies,
  type CodespaceResourcePolicy,
} from "@mcp-moira/shared";

const NOW = 1_800_000_000_000;

const availableConfig: CodespaceGitHubConfigStatus = {
  state: "available",
  clientId: "Iv23abcdefgh1234",
  clientSecret: "fixture-client-secret-not-a-real-credential",
  callbackUrl: "https://moira.example/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/moira-codespaces/installations/new",
  vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  vaultKeyVersion: "v1",
  settingsUrl: "https://moira.example/settings#integrations-github",
};

const policy: CodespaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxStorageBytes: 32 * 1024 ** 3,
  maxActivePerUser: 1,
  maxActiveGlobal: 4,
  createThrottleMs: 0,
  remoteTtlMs: 60_000,
  createDeadlineMs: 30_000,
  cleanupDeadlineMs: 30_000,
  claimLeaseMs: 5_000,
  reconcileIntervalMs: 30_000,
  startWaitMs: 60_000,
  maxConcurrentOperationsGlobal: 20,
  maxTransferBytesGlobal: 1024 ** 3,
};

function dependencies(
  overrides: Partial<CodespaceObservabilityDependencies> = {},
): CodespaceObservabilityDependencies {
  return {
    providerId: "github-codespaces",
    config: () => availableConfig,
    policy: () => policy,
    resources: {
      listControls: () => [
        { scope: "global", disabled: false, reason: null, updatedAt: null },
        { scope: "provider:github-codespaces", disabled: false, reason: null, updatedAt: null },
      ],
      countActive: () => 2,
      dueSummary: () => ({ count: 1, oldestUpdatedAt: NOW - 45_000 }),
    },
    operations: {
      countActive: () => 3,
      dueSummary: () => ({ count: 2, oldestUpdatedAt: NOW - 5_000 }),
    },
    transfers: {
      listLive: () =>
        [
          { declaredSize: 1024, observedSize: 512 },
          { declaredSize: 4096, observedSize: null },
        ] as ReturnType<CodespaceObservabilityDependencies["transfers"]["listLive"]>,
    },
    transport: { health: async () => ({ ok: true, reason: null }) },
    now: () => NOW,
    ...overrides,
  };
}

async function gauge(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = await metricsRegistry.getSingleMetric(name)!.get();
  const value = metric.values.find((entry) =>
    Object.entries(labels).every(([key, expected]) => entry.labels[key] === expected),
  );
  return value?.value ?? Number.NaN;
}

describe("codespace observability", () => {
  it("is ready only when configured, enabled, uncontrolled and the connector answers", async () => {
    const view = await new CodespaceObservabilityService(dependencies()).readiness();
    expect(view).toMatchObject({
      state: "ready",
      reason: null,
      configuration: "available",
      connector: { state: "available" },
      reconciliation: { due_resources: 1, due_operations: 2, oldest_due_age_ms: 45_000 },
      usage: {
        active_resources: 2,
        max_active_resources: 4,
        active_operations: 3,
        max_active_operations: 20,
        transfer_live_bytes: 512 + 4096,
        max_transfer_live_bytes: 1024 ** 3,
      },
      checked_at: NOW,
    });
    expect(JSON.stringify(view)).not.toMatch(/user|codespace_id|operation_id/);
    await expect(gauge("moira_codespace_ready", { provider: "github-codespaces" })).resolves.toBe(
      1,
    );
    await expect(gauge("moira_codespace_reconciliation_due", { kind: "operation" })).resolves.toBe(
      2,
    );
    await expect(
      gauge("moira_codespace_reconciliation_oldest_due_age_seconds", { kind: "resource" }),
    ).resolves.toBe(45);
    await expect(gauge("moira_codespace_active", { kind: "resource" })).resolves.toBe(2);
    await expect(gauge("moira_codespace_transfer_live_bytes")).resolves.toBe(4608);
  });

  it.each([
    [
      "disabled when configuration is absent",
      {
        config: () => ({ state: "disabled", reason: "NOT_CONFIGURED", settingsUrl: "x" }) as const,
      },
      { state: "disabled", reason: "NOT_CONFIGURED", configuration: "absent" },
    ],
    [
      "disabled when resources are switched off",
      { policy: () => ({ ...policy, enabled: false }) },
      { state: "disabled", reason: "RESOURCES_DISABLED", connector: { state: "not_applicable" } },
    ],
    [
      "misconfigured when configuration is invalid",
      {
        config: () =>
          ({ state: "invalid", reason: "INVALID_VAULT_KEY", settingsUrl: "x" }) as const,
      },
      { state: "misconfigured", reason: "INVALID_VAULT_KEY", configuration: "invalid" },
    ],
    [
      "control_disabled when a kill switch is on",
      {
        resources: {
          ...dependencies().resources,
          listControls: () => [
            { scope: "global" as const, disabled: true, reason: "incident", updatedAt: NOW },
            {
              scope: "provider:github-codespaces" as const,
              disabled: false,
              reason: null,
              updatedAt: null,
            },
          ],
        },
      },
      { state: "control_disabled", reason: "global" },
    ],
    [
      "connector_unavailable when the health probe fails",
      { transport: { health: async () => ({ ok: false, reason: "socket refused" }) } },
      { state: "connector_unavailable", reason: "socket refused" },
    ],
    [
      "connector_unavailable when the health probe throws",
      {
        transport: {
          health: async () => {
            throw new Error("boom");
          },
        },
      },
      { state: "connector_unavailable", reason: "health_probe_failed" },
    ],
  ])("reports %s", async (_name, overrides, expected) => {
    const view = await new CodespaceObservabilityService(
      dependencies(overrides as Partial<CodespaceObservabilityDependencies>),
    ).readiness();
    expect(view).toMatchObject(expected);
    await expect(gauge("moira_codespace_ready", { provider: "github-codespaces" })).resolves.toBe(
      0,
    );
  });

  it.each([
    ["disabled", false],
    ["control_disabled", false],
    ["ready", false],
    ["misconfigured", true],
    ["connector_unavailable", true],
  ] as const)("degrades instance health for %s: %s", (state, degraded) => {
    expect(isCodespaceReadinessDegraded({ state })).toBe(degraded);
  });

  it("projects only state, provider and degradation for public health surfaces", async () => {
    const view = await new CodespaceObservabilityService(
      dependencies({
        resources: {
          ...dependencies().resources,
          listControls: () => [
            {
              scope: "global" as const,
              disabled: true,
              reason: "private incident notes",
              updatedAt: NOW,
            },
            {
              scope: "provider:github-codespaces" as const,
              disabled: false,
              reason: null,
              updatedAt: null,
            },
          ],
        },
      }),
    ).readiness();
    const projected = projectPublicCodespaceReadiness(view);
    expect(projected).toEqual({
      state: "control_disabled",
      provider: "github-codespaces",
      degraded: false,
    });
    expect(JSON.stringify(projected)).not.toMatch(/private incident notes|usage|reconciliation/);
  });

  it("bounds the connector probe and serves liveness from the cached decision", async () => {
    let probes = 0;
    let clock = NOW;
    const service = new CodespaceObservabilityService(
      dependencies({
        now: () => clock,
        probeTimeoutMs: 20,
        snapshotMaxAgeMs: 10_000,
        transport: {
          health: () => {
            probes += 1;
            return new Promise(() => {
              // A stalled connector never answers.
            });
          },
        },
      }),
    );

    const first = await service.snapshot();
    expect(first).toMatchObject({
      state: "connector_unavailable",
      reason: "health_probe_timeout",
      connector: { state: "unavailable" },
    });
    expect(probes).toBe(1);

    clock += 5_000;
    const cached = await service.snapshot();
    expect(cached).toBe(first);
    expect(probes).toBe(1);

    clock += 6_000;
    const [a, b] = await Promise.all([service.snapshot(), service.snapshot()]);
    expect(a).toBe(b);
    expect(a.checked_at).toBe(clock);
    expect(probes).toBe(2);
  });

  it("does not probe the connector while the feature is disabled", async () => {
    let probed = false;
    await new CodespaceObservabilityService(
      dependencies({
        policy: () => ({ ...policy, enabled: false }),
        transport: {
          health: async () => {
            probed = true;
            return { ok: true, reason: null };
          },
        },
      }),
    ).readiness();
    expect(probed).toBe(false);
  });

  it("records audit events with closed labels and ignores unknown rejection codes", async () => {
    recordCodespaceConnectionEvent({
      action: "refresh_failed",
      userId: "user-private",
      provider: "github-codespaces",
      connectionId: "connection-private",
      outcome: "provider_rejected_refresh",
    });
    recordCodespaceResourceEvent({
      action: "start",
      userId: "user-private",
      provider: "github-codespaces",
      resourceId: "11111111-1111-4111-8111-111111111111",
      outcome: "verified_usable",
      state: "usable",
      machine: { name: "m", cpuCores: 2, memoryBytes: 1, storageBytes: 1 },
    });
    recordCodespaceOperationEvent(
      {
        action: "terminal",
        userId: "user-private",
        codespaceId: "11111111-1111-4111-8111-111111111111",
        operationId: "22222222-2222-4222-8222-222222222222",
        provider: "github-codespaces",
        state: "succeeded",
        kind: "exec",
        inputBytes: 0,
        outputBytes: 10,
        exitCode: 0,
        createdAt: NOW,
        updatedAt: NOW + 2_500,
      },
      2_500,
    );
    recordCodespaceRejection("CODESPACE_POLICY_LIMIT");
    recordCodespaceRejection("CODESPACE_START_TIMEOUT");
    recordCodespaceRejection("NOT_A_CLOSED_CODE");

    const rendered = await metricsRegistry.metrics();
    expect(rendered).toContain(
      'moira_codespace_connection_events_total{provider="github-codespaces",action="refresh_failed"} 1',
    );
    // A codespace that did not start in time is a bounded refusal like the others, so it is
    // counted under its own closed label rather than disappearing as an unknown code.
    expect(rendered).toContain(
      'moira_codespace_rejections_total{code="CODESPACE_START_TIMEOUT"} 1',
    );
    expect(rendered).not.toMatch(/connection-private|provider_rejected_refresh/);
    expect(rendered).toContain(
      'moira_codespace_lifecycle_events_total{provider="github-codespaces",action="start",state="usable"} 1',
    );
    expect(rendered).toContain(
      'moira_codespace_operation_events_total{provider="github-codespaces",kind="exec",action="terminal",state="succeeded"} 1',
    );
    expect(rendered).toMatch(
      /moira_codespace_operation_duration_seconds_count\{kind="exec",state="succeeded"\} 1/,
    );
    expect(rendered).toContain('moira_codespace_rejections_total{code="CODESPACE_POLICY_LIMIT"} 1');
    expect(rendered).not.toContain("NOT_A_CLOSED_CODE");
    expect(rendered).not.toMatch(/user-private|11111111-1111|22222222-2222/);
  });
});
