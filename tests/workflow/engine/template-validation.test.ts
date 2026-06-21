/**
 * Template Validation Tests (#430)
 *
 * Tests that GraphValidator.validateUnified() catches template syntax errors:
 * - Unclosed brackets ({{ without }})
 * - Unexpected closing brackets (}} without {{)
 * - Undefined variables (not in initialData)
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator } from "../../../packages/workflow-engine/src/validation/graph-validator.js";

// Base valid workflow to extend with specific test nodes
function makeWorkflow(nodes: object[], declaredGlobals?: Record<string, unknown>) {
  return {
    id: "test",
    metadata: { name: "Test", version: "1.0.0", description: "Test" },
    // Declared globals go in the registry (single source of truth for bare-name references).
    ...(declaredGlobals
      ? {
          variableRegistry: Object.fromEntries(
            Object.entries(declaredGlobals).map(([k, v]) => [
              k,
              {
                type:
                  typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string",
                description: k,
                default: v,
              },
            ]),
          ),
        }
      : {}),
    nodes,
  };
}

// Minimal valid workflow skeleton with agent-directive node
function validSkeletonWithDirective(
  directive: string,
  completionCondition: string,
  initialData?: Record<string, unknown>,
) {
  return makeWorkflow(
    [
      { id: "start", type: "start", connections: { default: "task" } },
      {
        id: "task",
        type: "agent-directive",
        directive,
        completionCondition,
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
    initialData,
  );
}

// Minimal valid workflow skeleton with telegram-notification node
function validSkeletonWithTelegram(message: string, initialData?: Record<string, unknown>) {
  return makeWorkflow(
    [
      { id: "start", type: "start", connections: { default: "notify" } },
      {
        id: "notify",
        type: "telegram-notification",
        chatId: "123456",
        message,
        connections: { default: "end" }, // telegram uses "default", not "success"
      },
      { id: "end", type: "end" },
    ],
    initialData,
  );
}

describe("Template Validation", () => {
  const validator = new GraphValidator();

  describe("Unclosed opening brackets", () => {
    test("directive with unclosed {{ is rejected", async () => {
      const wf = validSkeletonWithDirective(
        "Do something with {{variable and more text",
        "Task completed",
      );

      const result = await validator.validateUnified(wf);
      const error = result.issues.find(
        (i) => i.nodeId === "task" && i.field === "directive" && i.message.includes("unclosed"),
      );
      expect(error).toBeDefined();
      expect(error!.severity).toBe("error");
    });

    test("completionCondition with unclosed {{ is rejected", async () => {
      const wf = validSkeletonWithDirective("Do something", "Complete when {{result is ready");

      const result = await validator.validateUnified(wf);
      const error = result.issues.find(
        (i) =>
          i.nodeId === "task" &&
          i.field === "completionCondition" &&
          i.message.includes("unclosed"),
      );
      expect(error).toBeDefined();
      expect(error!.severity).toBe("error");
    });

    test("telegram message with unclosed {{ is rejected", async () => {
      const wf = validSkeletonWithTelegram("Notification: {{status without closing");

      const result = await validator.validateUnified(wf);
      const error = result.issues.find(
        (i) => i.nodeId === "notify" && i.field === "message" && i.message.includes("unclosed"),
      );
      expect(error).toBeDefined();
      expect(error!.severity).toBe("error");
    });

    test("nested unclosed bracket is detected", async () => {
      const wf = validSkeletonWithDirective(
        "First {{valid}} then {{broken and {{another}}",
        "Done",
      );

      const result = await validator.validateUnified(wf);
      const error = result.issues.find(
        (i) => i.nodeId === "task" && i.message.includes("unclosed"),
      );
      expect(error).toBeDefined();
    });
  });

  describe("Unexpected closing brackets", () => {
    test("directive with unexpected }} is rejected", async () => {
      const wf = validSkeletonWithDirective("Do something with variable}} and more", "Done");

      const result = await validator.validateUnified(wf);
      const error = result.issues.find(
        (i) => i.nodeId === "task" && i.field === "directive" && i.message.includes("unexpected"),
      );
      expect(error).toBeDefined();
      expect(error!.severity).toBe("error");
    });

    test("telegram message with unexpected }} is rejected", async () => {
      const wf = validSkeletonWithTelegram("Status: result}}");

      const result = await validator.validateUnified(wf);
      const error = result.issues.find(
        (i) => i.nodeId === "notify" && i.field === "message" && i.message.includes("unexpected"),
      );
      expect(error).toBeDefined();
    });
  });

  describe("Undefined variables", () => {
    test("variable not in registry/initialData generates error", async () => {
      const wf = validSkeletonWithDirective("Process {{undefined_var}} here", "Done", {
        defined_var: "value",
      });

      const result = await validator.validateUnified(wf);
      const error = result.issues.find(
        (i) =>
          i.nodeId === "task" &&
          i.severity === "error" &&
          i.message.includes("undefined_var") &&
          i.message.includes("undeclared"),
      );
      expect(error).toBeDefined();
    });

    test("defined variable passes validation", async () => {
      const wf = validSkeletonWithDirective("Process {{my_var}} here", "Done", { my_var: "value" });

      const result = await validator.validateUnified(wf);
      const undefinedWarning = result.issues.find(
        (i) => i.message.includes("not defined") && i.message.includes("my_var"),
      );
      expect(undefinedWarning).toBeUndefined();
    });

    test("system variables executionId and workflowId are allowed", async () => {
      const wf = validSkeletonWithDirective(
        "Execution: {{executionId}}, Workflow: {{workflowId}}",
        "Done",
      );

      const result = await validator.validateUnified(wf);
      const warnings = result.issues.filter(
        (i) =>
          i.severity === "warning" &&
          (i.message.includes("executionId") || i.message.includes("workflowId")),
      );
      expect(warnings).toHaveLength(0);
    });

    test("nested path variable checks root variable", async () => {
      const wf = validSkeletonWithDirective("User: {{user.name}}, Role: {{user.role}}", "Done", {
        user: { name: "Test", role: "admin" },
      });

      const result = await validator.validateUnified(wf);
      const undefinedWarning = result.issues.find(
        (i) => i.severity === "warning" && i.message.includes("not defined"),
      );
      expect(undefinedWarning).toBeUndefined();
    });

    test("undefined nested path root generates error", async () => {
      const wf = validSkeletonWithDirective("Data: {{unknown.path.here}}", "Done");

      const result = await validator.validateUnified(wf);
      const error = result.issues.find(
        (i) => i.severity === "error" && i.message.includes("unknown"),
      );
      expect(error).toBeDefined();
    });
  });

  describe("Control flow keywords are not flagged", () => {
    test("if/unless/each blocks are not flagged as undefined", async () => {
      const wf = validSkeletonWithDirective(
        "{{#if enabled}}Do this{{else}}Do that{{/if}}",
        "Done",
        { enabled: true },
      );

      const result = await validator.validateUnified(wf);
      // Should not warn about 'if', 'else', 'enabled' (enabled is defined)
      const controlFlowWarning = result.issues.find(
        (i) =>
          i.severity === "warning" &&
          (i.message.includes("'if'") ||
            i.message.includes("'else'") ||
            i.message.includes("'unless'")),
      );
      expect(controlFlowWarning).toBeUndefined();
    });

    test("each block is not flagged", async () => {
      const wf = validSkeletonWithDirective("{{#each items}}Item: {{this}}{{/each}}", "Done", {
        items: [],
      });

      const result = await validator.validateUnified(wf);
      const eachWarning = result.issues.find(
        (i) => i.severity === "warning" && i.message.includes("'each'"),
      );
      expect(eachWarning).toBeUndefined();
    });
  });

  describe("Valid templates pass", () => {
    test("properly closed brackets pass validation", async () => {
      const wf = validSkeletonWithDirective(
        "Process {{var1}} and {{var2}} here",
        "When {{result}} is {{status}}",
        { var1: "a", var2: "b", result: "x", status: "y" },
      );

      const result = await validator.validateUnified(wf);
      expect(result.valid).toBe(true);
      const templateErrors = result.issues.filter(
        (i) =>
          i.message.includes("unclosed") ||
          i.message.includes("unexpected") ||
          i.message.includes("not defined"),
      );
      expect(templateErrors).toHaveLength(0);
    });

    test("directive without templates passes validation", async () => {
      const wf = validSkeletonWithDirective("Just do this task", "Task is done");

      const result = await validator.validateUnified(wf);
      expect(result.valid).toBe(true);
    });

    test("empty directive fields still pass (caught by schema validation)", async () => {
      // Note: empty directive would fail schema validation, not template validation
      const wf = makeWorkflow([
        { id: "start", type: "start", connections: { default: "end" } },
        { id: "end", type: "end" },
      ]);

      const result = await validator.validateUnified(wf);
      expect(result.valid).toBe(true);
    });
  });

  describe("Multiple errors in same field", () => {
    test("reports first unclosed bracket position", async () => {
      const wf = validSkeletonWithDirective("First {{broken then {{also broken", "Done");

      const result = await validator.validateUnified(wf);
      const error = result.issues.find((i) => i.message.includes("unclosed"));
      expect(error).toBeDefined();
      // Should mention position of first unclosed bracket
      expect(error!.message).toMatch(/position \d+/);
    });
  });
});
