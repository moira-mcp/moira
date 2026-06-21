/**
 * Unified Validation Architecture Tests (#430 - Step 3)
 *
 * Tests that GraphValidator.validateUnified() produces correct UnifiedValidationResult
 * and that shared validateWorkflowUnified() produces the same format.
 * Verifies all consumers receive consistent error format.
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator } from "../../../packages/workflow-engine/src/validation/graph-validator.js";
import {
  getErrors,
  getWarnings,
} from "../../../packages/workflow-engine/src/validation/validation-types.js";
import {
  validateWorkflowUnified,
  validateWorkflow,
} from "../../../packages/shared/src/services/workflow-query-service.js";

// Minimal valid workflow for baseline tests
const VALID_WORKFLOW = {
  id: "test-valid",
  metadata: { name: "Test", version: "1.0.0", description: "Valid workflow" },
  nodes: [
    { id: "start", type: "start", connections: { default: "step" } },
    {
      id: "step",
      type: "agent-directive",
      directive: "Do something",
      completionCondition: "Done",
      connections: { success: "end" },
    },
    { id: "end", type: "end" },
  ],
};

describe("Unified Validation Architecture", () => {
  const validator = new GraphValidator();

  describe("UnifiedValidationResult format", () => {
    test("valid workflow returns valid=true with no error issues", async () => {
      const result = await validator.validateUnified(VALID_WORKFLOW);
      expect(result.valid).toBe(true);
      expect(getErrors(result)).toHaveLength(0);
    });

    test("each issue has required fields: type, severity, message", async () => {
      const invalid = {
        ...VALID_WORKFLOW,
        nodes: [
          { id: "start", type: "start", connections: { default: "missing-node" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(invalid);
      expect(result.valid).toBe(false);

      for (const issue of result.issues) {
        expect(issue).toHaveProperty("type");
        expect(issue).toHaveProperty("severity");
        expect(issue).toHaveProperty("message");
        expect(["schema", "structure", "node", "connection"]).toContain(issue.type);
        expect(["error", "warning"]).toContain(issue.severity);
      }
    });

    test("severity correctly separates errors from warnings", async () => {
      // Workflow with unreachable node (warning) but otherwise valid
      const withOrphan = {
        ...VALID_WORKFLOW,
        nodes: [
          ...VALID_WORKFLOW.nodes,
          {
            id: "orphan",
            type: "agent-directive",
            directive: "Orphan",
            completionCondition: "Done",
            connections: { success: "end" },
          },
        ],
      };

      const result = await validator.validateUnified(withOrphan);
      expect(result.valid).toBe(true); // warnings don't invalidate
      expect(getWarnings(result).length).toBeGreaterThan(0);
      expect(getErrors(result)).toHaveLength(0);

      const unreachableWarning = result.issues.find(
        (i) => i.severity === "warning" && i.message.includes("Unreachable"),
      );
      expect(unreachableWarning).toBeDefined();
    });
  });

  describe("Issue types", () => {
    test("error for missing start node (caught at schema level)", async () => {
      // A workflow missing start node fails AJV schema validation first
      // (nodes array doesn't satisfy oneOf requirements for a start node).
      // The result is invalid — the specific error type depends on AJV processing.
      const noStart = {
        id: "test",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [{ id: "end", type: "end" }],
      };

      const result = await validator.validateUnified(noStart);
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0].severity).toBe("error");
    });

    test("connection type for dangling references", async () => {
      const dangling = {
        id: "test",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "nonexistent" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(dangling);
      const connError = result.issues.find((i) => i.type === "connection");
      expect(connError).toBeDefined();
      expect(connError!.severity).toBe("error");
      expect(connError!.nodeId).toBe("start");
      expect(connError!.message).toContain("nonexistent");
    });

    test("structure type for duplicate node IDs", async () => {
      const duplicate = {
        id: "test",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(duplicate);
      const dupError = result.issues.find(
        (i) => i.type === "structure" && i.message.includes("Duplicate"),
      );
      expect(dupError).toBeDefined();
    });

    test("error for empty metadata name/version (caught at schema level)", async () => {
      // AJV schema requires minLength:1 for name and version,
      // catching these before structural validation runs.
      const emptyMeta = {
        id: "test",
        metadata: { name: "", version: "", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(emptyMeta);
      expect(result.valid).toBe(false);
      // Schema catches empty strings — errors should mention name or version
      const hasMetaError = result.issues.some(
        (i) =>
          i.severity === "error" && (i.message.includes("name") || i.message.includes("version")),
      );
      expect(hasMetaError).toBe(true);
    });
  });

  describe("Legacy format backward compatibility", () => {
    test("validateWorkflow returns GraphValidationResult format", async () => {
      const result = await validator.validateWorkflow(VALID_WORKFLOW);
      expect(result).toHaveProperty("valid");
      expect(result).toHaveProperty("errors");
      expect(result).toHaveProperty("warnings");
      expect(Array.isArray(result.errors)).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    test("legacy errors have type/message/nodeId fields", async () => {
      const dangling = {
        id: "test",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "missing" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateWorkflow(dangling);
      expect(result.valid).toBe(false);

      for (const error of result.errors) {
        expect(error).toHaveProperty("type");
        expect(error).toHaveProperty("message");
        expect(["schema", "structure", "connections", "references"]).toContain(error.type);
      }
    });

    test("unified and legacy agree on valid/invalid", async () => {
      const unified = await validator.validateUnified(VALID_WORKFLOW);
      const legacy = await validator.validateWorkflow(VALID_WORKFLOW);
      expect(unified.valid).toBe(legacy.valid);
    });
  });

  describe("Shared validateWorkflowUnified consistency", () => {
    test("produces UnifiedValidationResult format", () => {
      const result = validateWorkflowUnified(VALID_WORKFLOW as any);
      expect(result).toHaveProperty("valid");
      expect(result).toHaveProperty("issues");
      expect(Array.isArray(result.issues)).toBe(true);
    });

    test("detects same structural issues as GraphValidator", async () => {
      // Use a workflow that passes AJV but has structural issues
      // (dangling connection reference)
      const dangling = {
        id: "test",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "missing-ref" } },
          { id: "end", type: "end" },
        ],
      };

      const shared = validateWorkflowUnified(dangling as any);
      const graph = await validator.validateUnified(dangling);

      // Both should find connection issue
      const sharedConnError = shared.issues.find((i) => i.type === "connection");
      const graphConnError = graph.issues.find((i) => i.type === "connection");
      expect(sharedConnError).toBeDefined();
      expect(graphConnError).toBeDefined();

      // Both should report invalid
      expect(shared.valid).toBe(false);
      expect(graph.valid).toBe(false);
    });

    test("legacy validateWorkflow still returns ValidationResult with codes", () => {
      const noStart = {
        id: "test",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [{ id: "end", type: "end" }],
      };

      const result = validateWorkflow(noStart as any);
      expect(result).toHaveProperty("valid");
      expect(result).toHaveProperty("errors");
      expect(result).toHaveProperty("warnings");

      // Legacy format has error codes
      const startError = result.errors.find((e) => e.code === "MISSING_START");
      expect(startError).toBeDefined();
    });
  });

  describe("Field property in issues", () => {
    test("connection issues include field with connection path", async () => {
      const dangling = {
        id: "test",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "missing" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(dangling);
      const connIssue = result.issues.find((i) => i.type === "connection" && i.nodeId === "start");
      expect(connIssue).toBeDefined();
      expect(connIssue!.field).toContain("connections");
    });

    test("schema errors include context about what failed", async () => {
      // Empty name fails AJV schema validation (minLength:1)
      const noName = {
        id: "test",
        metadata: { name: "", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(noName);
      expect(result.valid).toBe(false);
      // Schema error should exist and contain info about the name field
      const nameError = result.issues.find(
        (i) => i.severity === "error" && i.message.includes("name"),
      );
      expect(nameError).toBeDefined();
    });
  });

  describe("getErrors and getWarnings helpers", () => {
    test("getErrors filters only error severity", async () => {
      const withOrphan = {
        ...VALID_WORKFLOW,
        nodes: [
          ...VALID_WORKFLOW.nodes,
          {
            id: "orphan",
            type: "agent-directive",
            directive: "Orphan",
            completionCondition: "Done",
            connections: { success: "end" },
          },
        ],
      };

      const result = await validator.validateUnified(withOrphan);
      const errors = getErrors(result);
      const warnings = getWarnings(result);

      for (const e of errors) expect(e.severity).toBe("error");
      for (const w of warnings) expect(w.severity).toBe("warning");
    });
  });

  describe("Teleport Node Validation", () => {
    test("should accept valid teleport node without incoming connections", async () => {
      const validator = new GraphValidator();
      const workflow = {
        id: "test-teleport",
        metadata: { name: "Test", version: "1.0.0", description: "Teleport test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive: "Do work",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
          {
            id: "teleport-replan",
            type: "teleport",
            directive: "Rewrite the plan",
            completionCondition: "Plan rewritten",
            hint: "Use when plan needs restructuring",
            connections: { success: "step" },
          },
        ],
      };

      const result = await validator.validateUnified(workflow);
      const errors = getErrors(result);
      // No errors expected — teleport is valid and not flagged as unreachable
      expect(errors).toHaveLength(0);
    });

    test("should reject teleport node with incoming connections", async () => {
      const validator = new GraphValidator();
      const workflow = {
        id: "test-teleport-invalid",
        metadata: { name: "Test", version: "1.0.0", description: "Invalid teleport" },
        nodes: [
          { id: "start", type: "start", connections: { default: "teleport-replan" } },
          {
            id: "teleport-replan",
            type: "teleport",
            directive: "Rewrite the plan",
            completionCondition: "Plan rewritten",
            hint: "Use when plan needs restructuring",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await validator.validateUnified(workflow);
      const errors = getErrors(result);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("must not have incoming connections"))).toBe(
        true,
      );
    });

    test("should not report teleport nodes as unreachable", async () => {
      const validator = new GraphValidator();
      const workflow = {
        id: "test-teleport-unreachable",
        metadata: { name: "Test", version: "1.0.0", description: "Teleport unreachable test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive: "Work",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
          {
            id: "teleport-escape",
            type: "teleport",
            directive: "Escape",
            completionCondition: "Escaped",
            hint: "Emergency exit",
            connections: { success: "step" },
          },
        ],
      };

      const result = await validator.validateUnified(workflow);
      const warnings = getWarnings(result);
      // Teleport should NOT appear in unreachable warnings
      const unreachableWarning = warnings.find((w) => w.message.includes("Unreachable"));
      expect(unreachableWarning).toBeUndefined();
    });
  });
});
