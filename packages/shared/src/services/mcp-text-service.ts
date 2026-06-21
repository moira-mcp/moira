/**
 * MCP Text Service - Load tool descriptions, system prompt, and error messages from DB
 *
 * This service provides access to agent-facing texts stored in globalSetting table.
 * All values are read from DB at request time (no cache).
 * If value not found in DB, returns empty string (no fallback to hardcoded values).
 *
 * Keys (with 3-level override hierarchy):
 * Default:
 * - mcp.toolDescription.{toolName} - Tool descriptions (list, start, step, manage, help, settings, token, session)
 * - mcp.systemPrompt - System prompt content (appended to help tool description)
 * - mcp.systemReminder - System reminder content
 * - mcp.errorMessages - Error message templates (JSON)
 * - mcp.validationHelp - Validation help messages (JSON)
 *
 * Agent-level overrides (e.g., for Claude, ChatGPT, Gemini):
 * - mcp.agent.{agent}.toolDescription.{toolName}
 * - mcp.agent.{agent}.systemPrompt
 * - mcp.agent.{agent}.systemReminder
 *
 * Model-level overrides (nested under agent to avoid vendor collisions):
 * - mcp.agent.{agent}.model.{model}.toolDescription.{toolName}
 * - mcp.agent.{agent}.model.{model}.systemPrompt
 * - mcp.agent.{agent}.model.{model}.systemReminder
 *
 * Resolution order: model → agent → default (first non-null wins)
 */

import type { GlobalSettingsRepository } from "../database/repositories/global-settings-repository.js";

// Tool names that have descriptions in DB
export const MCP_TOOL_NAMES = [
  "list",
  "start",
  "step",
  "manage",
  "help",
  "settings",
  "token",
  "session",
  "notes",
  "artifacts",
  "lock",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

// Key prefixes for different types of MCP texts
export const MCP_TEXT_KEYS = {
  // Default keys
  toolDescription: (toolName: string) => `mcp.toolDescription.${toolName}`,
  systemPrompt: "mcp.systemPrompt",
  systemReminder: "mcp.systemReminder",
  errorMessages: "mcp.errorMessages",
  validationHelp: "mcp.validationHelp",

  // Agent-level override keys
  agentToolDescription: (agent: string, toolName: string) =>
    `mcp.agent.${agent}.toolDescription.${toolName}`,
  agentSystemPrompt: (agent: string) => `mcp.agent.${agent}.systemPrompt`,
  agentSystemReminder: (agent: string) => `mcp.agent.${agent}.systemReminder`,

  // Model-level override keys (nested under agent to avoid vendor collisions)
  modelToolDescription: (agent: string, model: string, toolName: string) =>
    `mcp.agent.${agent}.model.${model}.toolDescription.${toolName}`,
  modelSystemPrompt: (agent: string, model: string) =>
    `mcp.agent.${agent}.model.${model}.systemPrompt`,
  modelSystemReminder: (agent: string, model: string) =>
    `mcp.agent.${agent}.model.${model}.systemReminder`,
} as const;

// Category for all MCP-related settings
export const MCP_CATEGORY = "mcp";

// Categories for override settings
export const MCP_AGENT_CATEGORY = "mcp-agent-prompts";
export const MCP_MODEL_CATEGORY = "mcp-model-prompts";

/**
 * Context for agent/model identification used in hierarchical prompt resolution
 */
export interface McpPromptContext {
  /** Agent identifier (e.g., "claude", "chatgpt", "gemini") */
  agent?: string | null;
  /** Model identifier (e.g., "claude-opus-4-5-20251101", "gpt-4o") */
  model?: string | null;
}

export class McpTextService {
  constructor(private globalSettingsRepo: GlobalSettingsRepository) {}

  /**
   * Get tool description by tool name
   * Returns empty string if not found in DB (no fallback)
   */
  async getToolDescription(toolName: McpToolName): Promise<string> {
    const key = MCP_TEXT_KEYS.toolDescription(toolName);
    const value = await this.globalSettingsRepo.getValue<string>(key);
    return value ?? "";
  }

  /**
   * Get all tool descriptions as a record
   * Returns empty strings for missing values
   */
  async getAllToolDescriptions(): Promise<Record<McpToolName, string>> {
    const result: Partial<Record<McpToolName, string>> = {};

    for (const toolName of MCP_TOOL_NAMES) {
      result[toolName] = await this.getToolDescription(toolName);
    }

    return result as Record<McpToolName, string>;
  }

  /**
   * Get system prompt content
   * Returns empty string if not found
   */
  async getSystemPrompt(): Promise<string> {
    const value = await this.globalSettingsRepo.getValue<string>(MCP_TEXT_KEYS.systemPrompt);
    return value ?? "";
  }

  /**
   * Get system reminder content
   * Returns empty string if not found
   */
  async getSystemReminder(): Promise<string> {
    const value = await this.globalSettingsRepo.getValue<string>(MCP_TEXT_KEYS.systemReminder);
    return value ?? "";
  }

  /**
   * Get error messages as JSON object
   * Returns empty object if not found or invalid JSON
   */
  async getErrorMessages(): Promise<Record<string, string>> {
    const value = await this.globalSettingsRepo.getValue<string>(MCP_TEXT_KEYS.errorMessages);
    if (!value) return {};

    try {
      return JSON.parse(value) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /**
   * Get validation help messages as JSON object
   * Returns empty object if not found or invalid JSON
   */
  async getValidationHelp(): Promise<Record<string, string[]>> {
    const value = await this.globalSettingsRepo.getValue<string>(MCP_TEXT_KEYS.validationHelp);
    if (!value) return {};

    try {
      return JSON.parse(value) as Record<string, string[]>;
    } catch {
      return {};
    }
  }

  // ============================================================================
  // HIERARCHICAL OVERRIDE METHODS
  // Resolution order: model → agent → default (first non-null wins)
  // ============================================================================

  /**
   * Get tool description with hierarchical override resolution.
   * Resolution order: model → agent → default
   *
   * @param toolName - The tool name
   * @param context - Agent and model context for override resolution
   * @returns The tool description (model override > agent override > default)
   */
  async getToolDescriptionWithOverride(
    toolName: McpToolName,
    context?: McpPromptContext,
  ): Promise<string> {
    const { agent, model } = context ?? {};

    // Try model-level override first (requires both agent and model)
    if (agent && model) {
      const modelKey = MCP_TEXT_KEYS.modelToolDescription(agent, model, toolName);
      const modelValue = await this.globalSettingsRepo.getValue<string>(modelKey);
      if (modelValue !== null && modelValue !== undefined) {
        return modelValue;
      }
    }

    // Try agent-level override
    if (agent) {
      const agentKey = MCP_TEXT_KEYS.agentToolDescription(agent, toolName);
      const agentValue = await this.globalSettingsRepo.getValue<string>(agentKey);
      if (agentValue !== null && agentValue !== undefined) {
        return agentValue;
      }
    }

    // Fall back to default
    return this.getToolDescription(toolName);
  }

  /**
   * Get all tool descriptions with hierarchical override resolution.
   *
   * @param context - Agent and model context for override resolution
   * @returns All tool descriptions as a record
   */
  async getAllToolDescriptionsWithOverride(
    context?: McpPromptContext,
  ): Promise<Record<McpToolName, string>> {
    const result: Partial<Record<McpToolName, string>> = {};

    for (const toolName of MCP_TOOL_NAMES) {
      result[toolName] = await this.getToolDescriptionWithOverride(toolName, context);
    }

    return result as Record<McpToolName, string>;
  }

  /**
   * Get system prompt with hierarchical override resolution.
   * Resolution order: model → agent → default
   *
   * @param context - Agent and model context for override resolution
   * @returns The system prompt (model override > agent override > default)
   */
  async getSystemPromptWithOverride(context?: McpPromptContext): Promise<string> {
    const { agent, model } = context ?? {};

    // Try model-level override first (requires both agent and model)
    if (agent && model) {
      const modelKey = MCP_TEXT_KEYS.modelSystemPrompt(agent, model);
      const modelValue = await this.globalSettingsRepo.getValue<string>(modelKey);
      if (modelValue !== null && modelValue !== undefined) {
        return modelValue;
      }
    }

    // Try agent-level override
    if (agent) {
      const agentKey = MCP_TEXT_KEYS.agentSystemPrompt(agent);
      const agentValue = await this.globalSettingsRepo.getValue<string>(agentKey);
      if (agentValue !== null && agentValue !== undefined) {
        return agentValue;
      }
    }

    // Fall back to default
    return this.getSystemPrompt();
  }

  /**
   * Get system reminder with hierarchical override resolution.
   * Resolution order: model → agent → default
   *
   * @param context - Agent and model context for override resolution
   * @returns The system reminder (model override > agent override > default)
   */
  async getSystemReminderWithOverride(context?: McpPromptContext): Promise<string> {
    const { agent, model } = context ?? {};

    // Try model-level override first (requires both agent and model)
    if (agent && model) {
      const modelKey = MCP_TEXT_KEYS.modelSystemReminder(agent, model);
      const modelValue = await this.globalSettingsRepo.getValue<string>(modelKey);
      if (modelValue !== null && modelValue !== undefined) {
        return modelValue;
      }
    }

    // Try agent-level override
    if (agent) {
      const agentKey = MCP_TEXT_KEYS.agentSystemReminder(agent);
      const agentValue = await this.globalSettingsRepo.getValue<string>(agentKey);
      if (agentValue !== null && agentValue !== undefined) {
        return agentValue;
      }
    }

    // Fall back to default
    return this.getSystemReminder();
  }
}
