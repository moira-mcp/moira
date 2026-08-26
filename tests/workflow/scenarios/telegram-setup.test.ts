/** Behavioral contracts for moira/telegram-setup v2.0.2. */
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphValidator,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario,
  type MockInput,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

const entry = findSystemCatalogEntry("telegram-setup", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
type NotificationMode = "sent" | "not_sent" | "error";

const configured = {
  configuration_outcome: "configured",
  configuration_summary:
    "Masked settings readback matched the intended current-user configuration.",
};
const received = {
  receipt_status: "received",
  receipt_summary: "The user confirmed receipt in the intended chat.",
};
const finish = (summary: string) => ({
  recovery_action: "finish_incomplete",
  recovery_summary: summary,
});
const retry = (summary: string) => ({
  recovery_action: "retry",
  recovery_summary: summary,
  changed_evidence: "The user corrected a setting or sent the required initial bot message.",
});
const reconfigure = (summary: string) => ({
  recovery_action: "reconfigure",
  recovery_summary: summary,
  changed_evidence: "The user chose to replace and re-verify the Telegram settings.",
});

function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    "resolve-setup": {
      setup_path: "test_existing",
      outcome_summary: "A masked token, chat ID and enabled state are already configured.",
    },
    "configure-settings": configured,
    "confirm-received": received,
    "recovery-send-error": finish("The send error remains unresolved."),
    "recovery-not-sent": finish("The handler did not report a sent message."),
    "recovery-not-received": finish("The sent message was not observed by the user."),
    ...overrides,
  };
}

function configureTelegram(engine: GraphExecutionEngine, modes: NotificationMode[]): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, any> }).nodeHandlers;
  let visit = 0;
  handlers.set("telegram-notification", {
    getNodeType: () => "telegram-notification",
    execute: async (current: { id: string }) => {
      const mode = modes[Math.min(visit++, modes.length - 1)] ?? "sent";
      if (mode === "error") {
        return {
          nodeId: current.id,
          action: "continue",
          outputPath: "error",
          data: {
            telegramNotificationFailed: true,
            errorMessage: "Telegram rejected the test request.",
          },
        };
      }
      return {
        nodeId: current.id,
        action: "continue",
        outputPath: "default",
        data: { telegramNotificationSent: mode === "sent" },
      };
    },
  });
}

async function run(
  scenario: TestScenario,
  modes: NotificationMode[] = ["sent"],
): Promise<ScenarioResult> {
  return runScenario(workflow(), scenario, {
    engineSetup: (engine) => configureTelegram(engine, modes),
  });
}

describe("telegram-setup", () => {
  test("publishes a valid secret-safe current-user setup contract", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.metadata.version).toBe("2.0.2");
    expect(graph.nodes).toHaveLength(26);
    expect(graph.metadata.description).toContain("skipTelegramCheck: true");
    expect(graph.metadata.description).toContain("Final output never contains the bot token");
    expect(graph.variableRegistry).toEqual({});

    for (const node of graph.nodes) {
      const properties = Object.keys((node as any).inputSchema?.properties ?? {});
      const finalOutput = (node as any).finalOutput ?? [];
      expect(properties).not.toEqual(expect.arrayContaining(["bot_token", "chat_id"]));
      expect(finalOutput.join(" ")).not.toMatch(/bot_token|chat_id/i);
      expect(JSON.stringify((node as any).directive ?? "")).not.toMatch(/\{\{[^}]*bot_token/i);
    }
  });

  test("uses masked readback and separates send, error, and receipt evidence", () => {
    const byId = (id: string): any => workflow().nodes.find((node) => node.id === id);
    expect(byId("resolve-setup").directive).toContain('settings({action: "get"');
    expect(byId("configure-settings").directive).toContain("masked token presence");
    expect(byId("configure-settings").directive).toContain("telegram.enabled=true");
    expect(byId("route-test-sent").condition.left.contextPath).toBe(
      "test-notification.telegramNotificationSent",
    );
    expect(byId("recovery-send-error").directive).toContain("{{test-notification.errorMessage}}");
    expect(byId("recovery-not-received").directive).toContain(
      "{{confirm-received.receipt_status}}",
    );
  });

  test.each([
    [
      "blocked setup without reason",
      "resolve-setup",
      { setup_path: "blocked", outcome_summary: "Blocked" },
    ],
    [
      "configured response without readback summary",
      "configure-settings",
      { configuration_outcome: "configured" },
    ],
    [
      "secret-shaped extra field",
      "configure-settings",
      { ...configured, bot_token: "123456789:SHOULD_NOT_ENTER_WORKFLOW_STATE" },
    ],
    [
      "retry without changed evidence",
      "recovery-send-error",
      { recovery_action: "retry", recovery_summary: "Try again." },
    ],
    [
      "finish with fake changed evidence",
      "recovery-not-sent",
      {
        recovery_action: "finish_incomplete",
        recovery_summary: "Stop here.",
        changed_evidence: "Decorative state",
      },
    ],
  ])("rejects contradictory input: %s", async (_name, target, invalid) => {
    const routeSetup: Record<string, MockInput> =
      target === "configure-settings"
        ? {
            "resolve-setup": {
              setup_path: "configure",
              outcome_summary: "Configuration is required.",
            },
          }
        : {};
    const modes: NotificationMode[] =
      target === "recovery-send-error"
        ? ["error"]
        : target === "recovery-not-sent"
          ? ["not_sent"]
          : ["sent"];
    const result = await run(
      {
        name: String(_name),
        mockInputs: inputs({ ...routeSetup, [String(target)]: invalid as MockInput }),
        expect: { status: "failed" },
      },
      modes,
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`Input validation failed for node '${String(target)}'`);
  });

  test("executes all outcome and cause-specific recovery routes", async () => {
    const cases: Array<{ scenario: TestScenario; modes?: NotificationMode[] }> = [
      {
        scenario: {
          name: "existing settings test received",
          mockInputs: inputs(),
          expect: { status: "completed", reaches: ["route-test-sent", "end-success"] },
        },
      },
      {
        scenario: {
          name: "new configuration received",
          mockInputs: inputs({
            "resolve-setup": {
              setup_path: "configure",
              outcome_summary: "The user chose to configure Telegram settings.",
            },
          }),
          expect: { status: "completed", reaches: ["configure-settings", "end-success"] },
        },
      },
      {
        scenario: {
          name: "skipped",
          mockInputs: inputs({
            "resolve-setup": { setup_path: "skip", outcome_summary: "The user declined setup." },
          }),
          expect: { status: "completed", reaches: ["end-skipped"], avoids: ["test-notification"] },
        },
      },
      {
        scenario: {
          name: "intake blocked",
          mockInputs: inputs({
            "resolve-setup": {
              setup_path: "blocked",
              outcome_summary: "Settings could not be inspected.",
              blocker_reason: "Current-user settings access is unavailable.",
            },
          }),
          expect: { status: "completed", reaches: ["end-blocked"], avoids: ["test-notification"] },
        },
      },
      {
        scenario: {
          name: "configuration blocked",
          mockInputs: inputs({
            "resolve-setup": {
              setup_path: "configure",
              outcome_summary: "Configuration is required.",
            },
            "configure-settings": {
              configuration_outcome: "blocked",
              blocker_reason: "Masked readback did not match the intended values.",
            },
          }),
          expect: { status: "completed", reaches: ["configure-settings", "end-blocked"] },
        },
      },
      {
        modes: ["not_sent"],
        scenario: {
          name: "handler not sent incomplete",
          mockInputs: inputs(),
          expect: {
            status: "completed",
            reaches: ["recovery-not-sent", "end-incomplete-not-sent"],
          },
        },
      },
      {
        modes: ["error"],
        scenario: {
          name: "thrown send error incomplete",
          mockInputs: inputs(),
          expect: {
            status: "completed",
            reaches: ["recovery-send-error", "end-incomplete-send-error"],
          },
        },
      },
      {
        scenario: {
          name: "user non-receipt incomplete",
          mockInputs: inputs({
            "confirm-received": {
              receipt_status: "not_received",
              receipt_summary: "The user did not see the sent test.",
            },
          }),
          expect: {
            status: "completed",
            reaches: ["recovery-not-received", "end-incomplete-not-received"],
          },
        },
      },
      {
        modes: ["error", "error"],
        scenario: {
          name: "send error retry then finish",
          mockInputs: inputs({
            "recovery-send-error": [
              retry("The user corrected the bot state before retry."),
              finish("The second send error remains unresolved."),
            ],
          }),
          expect: {
            status: "completed",
            reaches: ["route-retry-send-error", "end-incomplete-send-error"],
          },
        },
      },
      {
        modes: ["not_sent", "sent"],
        scenario: {
          name: "not-sent reconfigure then received",
          mockInputs: inputs({
            "recovery-not-sent": reconfigure("The user chose to replace settings."),
          }),
          expect: {
            status: "completed",
            reaches: ["route-reconfigure-not-sent", "configure-settings", "end-success"],
          },
        },
      },
      {
        modes: ["not_sent", "sent"],
        scenario: {
          name: "not-sent retry then received",
          mockInputs: inputs({
            "recovery-not-sent": retry("The user sent the initial bot message before retry."),
          }),
          expect: {
            status: "completed",
            reaches: ["route-retry-not-sent", "end-success"],
          },
        },
      },
      {
        modes: ["error", "sent"],
        scenario: {
          name: "send error reconfigure then received",
          mockInputs: inputs({
            "recovery-send-error": reconfigure("The user chose to replace settings."),
          }),
          expect: {
            status: "completed",
            reaches: ["route-reconfigure-send-error", "configure-settings", "end-success"],
          },
        },
      },
      {
        modes: ["sent", "sent"],
        scenario: {
          name: "non-receipt retry then received",
          mockInputs: inputs({
            "confirm-received": [
              {
                receipt_status: "not_received",
                receipt_summary: "The first test was not observed.",
              },
              received,
            ],
            "recovery-not-received": retry("The user changed the chat state before retry."),
          }),
          expect: { status: "completed", reaches: ["route-retry-not-received", "end-success"] },
        },
      },
      {
        modes: ["sent", "sent"],
        scenario: {
          name: "non-receipt reconfigure then received",
          mockInputs: inputs({
            "confirm-received": [
              {
                receipt_status: "not_received",
                receipt_summary: "The first test was not observed.",
              },
              received,
            ],
            "recovery-not-received": reconfigure("The user chose to replace settings."),
          }),
          expect: {
            status: "completed",
            reaches: ["route-reconfigure-not-received", "configure-settings", "end-success"],
          },
        },
      },
      {
        modes: ["error", "sent"],
        scenario: {
          name: "mixed causes do not reuse stale recovery action",
          mockInputs: inputs({
            "recovery-send-error": retry("The user corrected settings before retry."),
            "confirm-received": {
              receipt_status: "not_received",
              receipt_summary: "The retried send was not observed.",
            },
            "recovery-not-received": finish("Finish on the current non-receipt cause."),
          }),
          expect: {
            status: "completed",
            reaches: [
              "recovery-send-error",
              "recovery-not-received",
              "end-incomplete-not-received",
            ],
            avoids: ["end-incomplete-send-error"],
          },
        },
      },
    ];

    const results: ScenarioResult[] = [];
    for (const current of cases) {
      const result = await run(current.scenario, current.modes);
      results.push(result);
      if (!result.passed) throw new Error(`${current.scenario.name}: ${JSON.stringify(result)}`);
    }
    const coverage = calculateCoverage(workflow(), results, { includeGapAnalysis: true });
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
