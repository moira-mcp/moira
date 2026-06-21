/**
 * Core exports for MCP Moira
 * Central export point for core functionality
 */

export { MCPEngine, MCPEngineClass } from "./mcp-engine.js";

// Re-export AppError classes from shared for backward compatibility
// Consumers should prefer importing directly from @mcp-moira/shared
export {
  AppError,
  NotFoundError,
  ValidationError,
  InternalError,
  ConfigurationError,
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";
