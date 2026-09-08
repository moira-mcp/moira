/**
 * Unit tests for MCP Server messages module
 * Verifies centralized error messages are properly formatted
 */

import { describe, it, expect } from "@jest/globals";
import { ConflictError } from "@mcp-moira/shared";
import {
  ERRORS,
  SUCCESS,
  LABELS,
  VALIDATION_HELP,
  AGENT_INSTRUCTIONS,
  formatError,
  formatDomainError,
  formatErrorWithAgentInstructions,
} from "../../../packages/mcp-server/src/messages/en.js";

describe("MCP Messages Module", () => {
  describe("ERRORS", () => {
    it("should have all required error message functions", () => {
      // Generic errors
      expect(ERRORS.unknown_error).toBeDefined();
      expect(ERRORS.tool_not_found).toBeDefined();
      expect(ERRORS.unknown_action).toBeDefined();

      // Workflow errors
      expect(ERRORS.workflow_not_found).toBeDefined();
      expect(ERRORS.workflow_id_required).toBeDefined();

      // Execution errors
      expect(ERRORS.execution_not_found).toBeDefined();
      expect(ERRORS.execution_access_denied).toBeDefined();
      expect(ERRORS.cannot_edit_execution).toBeDefined();

      // Help/Documentation errors
      expect(ERRORS.documentation_file_not_found).toBeDefined();
      expect(ERRORS.unknown_help_topic).toBeDefined();
    });

    it("should generate correct error messages with parameters", () => {
      expect(ERRORS.tool_not_found("my_tool")).toBe("Tool 'my_tool' not found in registry");
      expect(ERRORS.workflow_not_found("wf-123")).toBe("Workflow 'wf-123' not found");
      expect(ERRORS.execution_not_found("exec-456")).toBe("Execution 'exec-456' not found");
      // Issue #386: "waiting" merged into "running"
      expect(ERRORS.cannot_edit_execution("completed")).toBe(
        "Cannot edit execution in state 'completed'. Only 'running' executions can be edited.",
      );
      expect(ERRORS.unknown_help_topic("invalid_topic")).toBe("Unknown topic: invalid_topic");
    });

    it("should generate documentation_file_not_found with path info", () => {
      const result = ERRORS.documentation_file_not_found("nodes.mdx", "/app/docs");
      expect(result).toContain("Documentation file not found: nodes.mdx");
      expect(result).toContain("DOCS_DIR");
      expect(result).toContain("/app/docs");
    });
  });

  describe("SUCCESS", () => {
    it("should have all required success message functions", () => {
      expect(SUCCESS.workflow_started).toBeDefined();
      expect(SUCCESS.workflow_created).toBeDefined();
      expect(SUCCESS.workflow_updated).toBeDefined();
      expect(SUCCESS.setting_updated).toBeDefined();
      expect(SUCCESS.context_updated).toBeDefined();
    });

    it("should generate correct success messages", () => {
      expect(SUCCESS.workflow_created("my-wf")).toBe("Workflow 'my-wf' created successfully");
      expect(SUCCESS.context_updated("exec-123")).toBe("Execution context updated for 'exec-123'");
    });
  });

  // TOOL_DESCRIPTIONS removed - descriptions are loaded dynamically from DB
  // See mcp-text-service.test.ts for DB loading tests

  describe("LABELS", () => {
    it("should have all UI labels defined", () => {
      expect(LABELS.no_result).toBe("No result");
      expect(LABELS.no_workflows).toBe("No workflows available");
      expect(LABELS.upload_url).toBe("Upload URL");
    });
  });

  describe("VALIDATION_HELP", () => {
    it("should have help categories", () => {
      expect(VALIDATION_HELP.general).toBeDefined();
      expect(VALIDATION_HELP.json_format).toBeDefined();
      expect(VALIDATION_HELP.workflow_troubleshooting).toBeDefined();
      expect(VALIDATION_HELP.process_troubleshooting).toBeDefined();
    });

    it("should have new troubleshooting categories", () => {
      // New categories added in Step 7 for error hints
      expect(VALIDATION_HELP.auth_troubleshooting).toBeDefined();
      expect(VALIDATION_HELP.connection_troubleshooting).toBeDefined();
      expect(VALIDATION_HELP.tool_update_troubleshooting).toBeDefined();
      expect(VALIDATION_HELP.settings_troubleshooting).toBeDefined();
      expect(VALIDATION_HELP.help_troubleshooting).toBeDefined();
    });

    it("should have array of help items in each category", () => {
      expect(Array.isArray(VALIDATION_HELP.general)).toBe(true);
      expect(VALIDATION_HELP.general.length).toBeGreaterThan(0);

      // Verify new categories have content
      expect(Array.isArray(VALIDATION_HELP.auth_troubleshooting)).toBe(true);
      expect(VALIDATION_HELP.auth_troubleshooting.length).toBeGreaterThan(0);
      expect(Array.isArray(VALIDATION_HELP.settings_troubleshooting)).toBe(true);
      expect(VALIDATION_HELP.settings_troubleshooting.length).toBeGreaterThan(0);
    });
  });

  describe("AGENT_INSTRUCTIONS", () => {
    it("should have all required agent instruction categories", () => {
      expect(AGENT_INSTRUCTIONS.workflow_not_found).toBeDefined();
      expect(AGENT_INSTRUCTIONS.stale_attempt).toBeDefined();
      expect(AGENT_INSTRUCTIONS.processing_attempt).toBeDefined();
      expect(AGENT_INSTRUCTIONS.conflicting_attempt).toBeDefined();
      expect(AGENT_INSTRUCTIONS.invalid_step_attempt).toBeDefined();
      expect(AGENT_INSTRUCTIONS.outcome_unknown).toBeDefined();
      expect(AGENT_INSTRUCTIONS.process_not_found).toBeDefined();
      expect(AGENT_INSTRUCTIONS.validation_failed).toBeDefined();
      expect(AGENT_INSTRUCTIONS.auth_required).toBeDefined();
      expect(AGENT_INSTRUCTIONS.connection_error).toBeDefined();
      expect(AGENT_INSTRUCTIONS.access_denied).toBeDefined();
      expect(AGENT_INSTRUCTIONS.unrecoverable).toBeDefined();
    });

    it("should contain AGENT INSTRUCTIONS header", () => {
      for (const [, instructions] of Object.entries(AGENT_INSTRUCTIONS)) {
        expect(instructions).toContain("AGENT INSTRUCTIONS:");
      }
    });

    it("should contain STOP instruction only in categories that require a user boundary", () => {
      for (const [category, instructions] of Object.entries(AGENT_INSTRUCTIONS)) {
        if (
          category === "stale_attempt" ||
          category === "processing_attempt" ||
          category === "conflicting_attempt" ||
          category === "invalid_step_attempt"
        )
          continue;
        expect(instructions.toLowerCase()).toContain("stop");
      }
      expect(AGENT_INSTRUCTIONS.stale_attempt.toLowerCase()).not.toContain("stop");
      expect(AGENT_INSTRUCTIONS.processing_attempt.toLowerCase()).not.toContain("stop");
      expect(AGENT_INSTRUCTIONS.conflicting_attempt.toLowerCase()).not.toContain("stop");
      expect(AGENT_INSTRUCTIONS.invalid_step_attempt.toLowerCase()).not.toContain("stop");
    });

    it("should contain numbered steps", () => {
      for (const [, instructions] of Object.entries(AGENT_INSTRUCTIONS)) {
        expect(instructions).toMatch(/1\./);
        expect(instructions).toMatch(/2\./);
      }
    });
  });

  describe("formatError", () => {
    it("should return message as-is without help category", () => {
      const result = formatError("Test error");
      expect(result).toBe("Test error");
    });

    it("should append troubleshooting help when category provided", () => {
      const result = formatError("Validation failed", "general");
      expect(result).toContain("Validation failed");
      expect(result).toContain("Troubleshooting:");
      expect(result).toContain("•");
    });

    it("should append agent instructions when agentCategory provided", () => {
      const result = formatError("Workflow not found", undefined, "workflow_not_found");
      expect(result).toContain("Workflow not found");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("STOP");
    });

    it("should append both help and agent instructions", () => {
      const result = formatError(
        "Workflow not found",
        "workflow_troubleshooting",
        "workflow_not_found",
      );
      expect(result).toContain("Workflow not found");
      expect(result).toContain("Troubleshooting:");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("list()");
    });
  });

  describe("formatErrorWithAgentInstructions", () => {
    it("should detect workflow_not_found errors", () => {
      const result = formatErrorWithAgentInstructions("Workflow 'test-flow' not found");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("list()");
      expect(result).toContain("Troubleshooting:");
    });

    it("should make stale attempts automatically recoverable without a user stop", () => {
      const result = formatErrorWithAgentInstructions(
        "ATTEMPT_STALE: this attempt no longer matches the current workflow step",
      );
      expect(result).toContain("session({ action: 'current_step'");
      expect(result).toContain("No user guidance is required");
      expect(result.toLowerCase()).not.toContain("stop");
    });

    it("should refresh current state after a conflicting attempt without replaying stale input", () => {
      const result = formatErrorWithAgentInstructions(
        "ATTEMPT_CONFLICT: this attempt was already submitted with different input",
      );
      expect(result).toContain("session({ action: 'current_step'");
      expect(result).toContain("Do NOT reuse the conflicting attempt ID");
      expect(result).toContain("returned directive and input schema");
      expect(result.toLowerCase()).not.toContain("stop");
      expect(result.toLowerCase()).not.toContain("wait for user guidance");
    });

    it("should retry a still-processing attempt with the identical identity and input", () => {
      const result = formatErrorWithAgentInstructions(
        "ATTEMPT_PROCESSING: this attempt is still processing. Retry the same attempt.",
      );
      expect(result).toContain("same Process ID, attempt ID, and input");
      expect(result).toContain("Do NOT create a replacement attempt");
      expect(result.toLowerCase()).not.toContain("stop");
      expect(result.toLowerCase()).not.toContain("wait for user guidance");
    });

    it("should preserve attempt-specific recovery through domain error formatting", () => {
      const result = formatDomainError(
        new ConflictError("ATTEMPT_PROCESSING: this attempt is still processing."),
      );
      expect(result).toContain("same Process ID, attempt ID, and input");
      expect(result.toLowerCase()).not.toContain("stop");
      expect(result).not.toContain("Review the inputSchema");
    });

    it("should refresh current state for an unavailable step attempt when the engine permits it", () => {
      const result = formatErrorWithAgentInstructions(
        "ATTEMPT_INVALID_OR_EXPIRED: the attempt is unavailable. Read session current_step and use its current attempt.",
      );
      expect(result).toContain("session({ action: 'current_step'");
      expect(result).toContain("Do NOT reuse the unavailable attempt ID");
      expect(result).toContain("returned directive and input schema");
      expect(result.toLowerCase()).not.toContain("stop");
    });

    it("should not invent current-step recovery for an unavailable start attempt", () => {
      const result = formatErrorWithAgentInstructions(
        "ATTEMPT_INVALID_OR_EXPIRED: the attempt is unavailable.",
      );
      expect(result).toContain("STOP and report the full error details to user");
      expect(result).not.toContain("Do NOT reuse the unavailable attempt ID");
    });

    it("should inspect outcome-unknown attempts without authorizing an automatic retry", () => {
      const result = formatErrorWithAgentInstructions(
        "ATTEMPT_OUTCOME_UNKNOWN: this workflow mutation may already have produced effects",
      );
      expect(result).toContain("Inspect the execution");
      expect(result).toContain("Do NOT retry the mutation automatically");
      expect(result.toLowerCase()).toContain("stop");
      expect(result).not.toContain("Retry the intended step once");
    });

    it("should detect process_not_found errors", () => {
      const result = formatErrorWithAgentInstructions("Process not found or expired");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("session({ action: 'executions' })");
    });

    it("should detect execution_not_found errors", () => {
      const result = formatErrorWithAgentInstructions("Execution 'abc-123' not found");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("session({ action: 'executions' })");
    });

    it("should detect validation errors", () => {
      const result = formatErrorWithAgentInstructions("Validation failed: missing required field");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("inputSchema");
    });

    it("should detect JSON parsing errors", () => {
      const result = formatErrorWithAgentInstructions("JSON parse error: unexpected token");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("Troubleshooting:");
    });

    it("should detect authentication errors", () => {
      const result = formatErrorWithAgentInstructions("Authentication required");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("reconnect");
    });

    it("should detect access_denied errors", () => {
      const result = formatErrorWithAgentInstructions("Access denied to this resource");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("permission");
    });

    it("should detect connection errors", () => {
      const result = formatErrorWithAgentInstructions("Connection timeout");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("retry");
    });

    it("should use unrecoverable for unknown errors", () => {
      const result = formatErrorWithAgentInstructions("Some completely unknown error");
      expect(result).toContain("AGENT INSTRUCTIONS:");
      expect(result).toContain("cannot be automatically recovered");
    });

    it("should always contain STOP instruction", () => {
      const testCases = [
        "Workflow not found",
        "Process expired",
        "Validation failed",
        "Access denied",
        "Connection error",
        "Unknown internal error",
      ];
      for (const msg of testCases) {
        const result = formatErrorWithAgentInstructions(msg);
        expect(result.toLowerCase()).toContain("stop");
      }
    });

    it("should always contain Do NOT continue instruction", () => {
      const testCases = [
        "Workflow not found",
        "Process expired",
        "Validation failed",
        "Access denied",
        "Connection error",
        "Unknown internal error",
      ];
      for (const msg of testCases) {
        const result = formatErrorWithAgentInstructions(msg);
        expect(result).toContain("Do NOT continue independently");
      }
    });
  });
});
