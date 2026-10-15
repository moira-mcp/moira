import { describe, expect, test } from "@jest/globals";
import {
  CodespaceObservabilityService,
  projectPublicCodespaceReadiness,
  metricsRegistry,
  recordCodespaceConnectionEvent,
  recordCodespaceRejection,
} from "@mcp-moira/shared";

describe("codespace configuration observation", () => {
  test("a changed admission configuration is observed without a cached ready decision or execution metadata", async () => {
    let enabled = true,
      now = 1;
    const service = new CodespaceObservabilityService({
      providerId: "github-codespaces",
      config: () => ({ state: "available" }),
      policy: () => ({ enabled }),
      now: () => now,
    });
    const first = await service.snapshot();
    expect(first).toMatchObject({
      state: "ready",
      checked_at: 1,
    });
    enabled = false;
    now = 2;
    const next = await service.snapshot();
    expect(next).toMatchObject({ state: "disabled", checked_at: 2 });
    expect(next).not.toHaveProperty("reconciliation");
    expect(next).not.toHaveProperty("usage");
    expect(next).not.toHaveProperty("controls");
    expect(next).not.toHaveProperty("connector");
  });
  test("public health carries only configuration status and keeps private reasons private", async () => {
    const service = new CodespaceObservabilityService({
      providerId: "github-codespaces",
      config: () => ({ state: "invalid", reason: "private config diagnostic" }),
      policy: () => ({ enabled: true }),
    });
    expect(projectPublicCodespaceReadiness(await service.readiness())).toEqual({
      state: "misconfigured",
      provider: "github-codespaces",
      degraded: true,
    });
  });
  test("connection and admission counters keep identities and unknown failure text out of metric labels", async () => {
    recordCodespaceConnectionEvent({
      action: "refresh_failed",
      userId: "private-user",
      provider: "github-codespaces",
      connectionId: "private-connection",
      outcome: "private-provider-detail",
    });
    recordCodespaceRejection("CODESPACE_GENERATION_CONFLICT");
    recordCodespaceRejection("private-arbitrary-code");
    const rendered = await metricsRegistry.metrics();
    expect(rendered).toContain(
      'moira_codespace_connection_events_total{provider="github-codespaces",action="refresh_failed"} 1',
    );
    expect(rendered).toContain(
      'moira_codespace_rejections_total{code="CODESPACE_GENERATION_CONFLICT"} 1',
    );
    expect(rendered).not.toMatch(
      /private-user|private-connection|private-provider-detail|private-arbitrary-code/,
    );
  });
});
