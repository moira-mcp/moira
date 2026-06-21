#!/usr/bin/env node

/**
 * Export MCP tools context as Claude sees it in system prompt
 *
 * This utility extracts MCP tool definitions with full schemas and descriptions,
 * calculates metrics, and outputs JSON for before/after comparison.
 */

import fs from "fs";
import path from "path";

// Tool definitions as registered in server.ts
// This matches EXACTLY what Claude sees in system context
const toolDefinitions = [
  {
    name: "list_workflows",
    description: "",
    inputSchema: {},
  },
  {
    name: "start_workflow",
    description: "",
    inputSchema: {
      workflowId: {
        type: "string",
      },
    },
  },
  {
    name: "execute_step",
    description: "",
    inputSchema: {
      processId: {
        type: "string",
      },
      input: {
        anyOf: [
          { type: "string" },
          { type: "object" },
          { type: "array" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
        ],
      },
    },
  },
  {
    name: "manage_workflow",
    description: "",
    inputSchema: {
      action: {
        type: "string",
        enum: ["create", "edit", "get"],
      },
      workflowId: {
        type: "string",
      },
      workflow: {
        type: "object",
        properties: {
          id: { type: "string" },
          metadata: {
            type: "object",
            properties: {
              name: { type: "string" },
              version: { type: "string" },
              description: { type: "string" },
            },
            required: ["name", "version", "description"],
          },
          nodes: { type: "array" },
          visibility: { type: "string", enum: ["public", "private"] },
        },
        required: ["metadata", "nodes"],
      },
      overwrite: {
        type: "boolean",
      },
      changes: {
        type: "object",
        properties: {
          metadata: {
            type: "object",
            properties: {
              name: { type: "string" },
              version: { type: "string" },
              description: { type: "string" },
            },
          },
          addNodes: {
            type: "array",
          },
          removeNodes: {
            type: "array",
            items: { type: "string" },
          },
          updateNodes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                nodeId: { type: "string" },
                changes: { type: "object" },
              },
              required: ["nodeId"],
            },
          },
        },
      },
      includeNodes: {
        type: "boolean",
      },
      includeValidation: {
        type: "boolean",
      },
      offset: {
        type: "number",
      },
      limit: {
        type: "number",
      },
    },
  },
  {
    name: "get_session_info",
    description: "",
    inputSchema: {
      action: {
        type: "string",
        enum: ["user", "executions", "execution_context", "current_step"],
      },
      executionId: {
        type: "string",
      },
    },
  },
  {
    name: "get_help",
    description: "",
    inputSchema: {
      topic: {
        type: "string",
      },
    },
  },
  {
    name: "settings",
    description: "",
    inputSchema: {
      action: {
        type: "string",
        enum: ["get", "set", "list"],
      },
      category: {
        type: "string",
      },
      key: {
        type: "string",
      },
      value: {},
    },
  },
  {
    name: "create_workflow_token",
    description: "Generate temporary token for uploading/downloading large workflows",
    inputSchema: {
      action: {
        type: "string",
        enum: ["upload", "download"],
      },
      workflowId: {
        type: "string",
      },
      ttlMinutes: {
        type: "number",
      },
    },
  },
];

// Calculate metrics
function calculateMetrics(tools: typeof toolDefinitions) {
  const toolJson = JSON.stringify(tools, null, 2);
  const totalChars = toolJson.length;

  const perToolMetrics = tools.map((tool) => {
    const toolJson = JSON.stringify(tool, null, 2);
    return {
      name: tool.name,
      description: tool.description,
      descriptionLength: tool.description.length,
      totalSize: toolJson.length,
      parameterCount: Object.keys(tool.inputSchema).length,
    };
  });

  const totalDescriptionLength = perToolMetrics.reduce(
    (sum, tool) => sum + tool.descriptionLength,
    0,
  );

  return {
    totalTools: tools.length,
    totalChars,
    totalDescriptionLength,
    averageDescriptionLength: Math.round(totalDescriptionLength / tools.length),
    perToolMetrics: perToolMetrics.sort((a, b) => b.totalSize - a.totalSize),
  };
}

// Main export
function exportMCPContext() {
  const metrics = calculateMetrics(toolDefinitions);

  const output = {
    exportDate: new Date().toISOString(),
    summary: {
      totalTools: metrics.totalTools,
      totalChars: metrics.totalChars,
      totalDescriptionLength: metrics.totalDescriptionLength,
      averageDescriptionLength: metrics.averageDescriptionLength,
    },
    tools: toolDefinitions,
    metrics: metrics.perToolMetrics,
  };

  const outputPath = path.join(process.cwd(), "mcp-tools-context.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log("=== MCP Tools Context Export ===");
  console.log(`Total tools: ${metrics.totalTools}`);
  console.log(`Total chars: ${metrics.totalChars.toLocaleString()}`);
  console.log(`Total description length: ${metrics.totalDescriptionLength} chars`);
  console.log(`Average description length: ${metrics.averageDescriptionLength} chars`);
  console.log("\nTop 5 largest tools:");
  metrics.perToolMetrics.slice(0, 5).forEach((tool, i) => {
    console.log(
      `  ${i + 1}. ${tool.name}: ${tool.totalSize} chars (desc: ${tool.descriptionLength} chars)`,
    );
  });
  console.log(`\nOutput written to: ${outputPath}`);
}

exportMCPContext();
