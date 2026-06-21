/**
 * Execute step function for direct import (no spawn)
 * Pure library function - no CLI behavior
 *
 * Architecture: "Throw Early, Catch Late, Log Once at Boundary"
 * - This is the MCP BOUNDARY - single place for logging MCP tool errors
 * - MCPEngine throws errors, this handler catches, logs, and formats response
 */

import { MCPEngine } from "../core/mcp-engine.js";
import { ToolResult, WorkflowSpecificParams } from "./interfaces/tool-interface.js";
import {
  createLogger,
  ValidationError,
  NotFoundError,
  isOperationalError,
  normalizeError,
} from "@mcp-moira/shared";
import { formatError, formatErrorWithAgentInstructions } from "../messages/index.js";
import { parseFlexibleJSON } from "../utils/flexible-json-parser.js";

const logger = createLogger({ component: "ExecuteStep" });

interface ExecuteStepParams extends WorkflowSpecificParams {
  processId: string;
  input?: unknown;
  teleportTo?: string;
}

/**
 * Universal input data parser with user-friendly format support
 * Handles direct input and flexible JSON formats (single quotes, unquoted keys)
 */
export function parseInputData(input: unknown): unknown {
  logger.debug("Parsing input data", {
    inputType: typeof input,
    isArray: Array.isArray(input),
    hasParamsInput: input && typeof input === "object" && "input" in input,
  });

  // Handle null/undefined
  if (input === null || input === undefined) {
    logger.debug("Input is null/undefined, returning empty object");
    return {};
  }

  // Handle string input - enhanced JSON parsing with user-friendly formats
  if (typeof input === "string") {
    logger.debug("Processing string input", { inputLength: input.length });

    // Empty string
    if (input.trim() === "") {
      return {};
    }

    // Try to parse with enhanced user-friendly JSON support
    try {
      const parsed = parseFlexibleJSON(input);
      logger.debug("Successfully parsed flexible JSON from string", { parsedType: typeof parsed });
      return parsed;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown JSON error";
      logger.debug("Flexible JSON parsing failed, using string as-is", {
        error: errorMessage,
        inputPreview: input.substring(0, 50) + (input.length > 50 ? "..." : ""),
      });

      // Enhanced error context for debugging
      if (input.includes("{") || input.includes("[")) {
        logger.debug("Input appears to be malformed JSON", {
          startsWithBrace: input.trim().startsWith("{"),
          startsWithBracket: input.trim().startsWith("["),
          hasUnmatchedBraces:
            (input.match(/\{/g) || []).length !== (input.match(/\}/g) || []).length,
          suggestion: "Check for missing quotes, brackets, or commas",
        });
      }

      // Return as string value if all parsing fails
      return { value: input };
    }
  }

  // Handle direct object/array input
  if (typeof input === "object") {
    logger.debug("Processing object input directly");
    return input;
  }

  // Handle primitive types (number, boolean)
  logger.debug("Processing primitive input", { inputType: typeof input });
  return { value: input };
}

export async function executeStep(params: ExecuteStepParams): Promise<ToolResult<string>> {
  try {
    // Use singleton MCPEngine for shared state management
    // MCPEngine is now a constant

    // Enhanced input processing with universal parser
    const stepParams = parseInputData(params.input);

    logger.info("Executing workflow step", {
      processId: params.processId.slice(0, 8),
      hasInput: !!params.input,
      hasTeleportTo: !!params.teleportTo,
      parsedInputType: typeof stepParams,
      parsedInputKeys:
        typeof stepParams === "object" && stepParams ? Object.keys(stepParams) : null,
    });

    const formattedText = await MCPEngine.getInstance().executeStep(
      params.processId,
      stepParams,
      params.teleportTo,
    );

    return { success: true, data: formattedText };
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to execute step", appError, {
      processId: params.processId,
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Note: All step attempts are logged by MCPEngine:
    // - EXECUTION_STEP for successful transitions
    // - EXECUTION_STEP_ATTEMPT for validation/handler errors that return pause
    // - EXECUTION_STEP_FAIL for exceptions
    // No additional audit logging needed here

    // Format error message with agent instructions based on error type
    let enhancedError: string;

    if (appError instanceof ValidationError) {
      enhancedError = formatError(appError.message, "general", "validation_failed");
    } else if (appError instanceof NotFoundError) {
      enhancedError = formatError(
        appError.message,
        "workflow_troubleshooting",
        "workflow_not_found",
      );
    } else {
      // For other errors, use auto-detection for agent instructions
      enhancedError = formatErrorWithAgentInstructions(appError.message);
    }

    return {
      success: false,
      error: enhancedError,
    };
  }
}
