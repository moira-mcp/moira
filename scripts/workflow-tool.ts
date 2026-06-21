#!/usr/bin/env tsx

/**
 * Workflow Management Tool (TypeScript version)
 *
 * Uses WorkflowQueryService from @mcp-moira/shared for core operations.
 * Provides CLI interface for workflow analysis and editing.
 *
 * Usage:
 *   npm run workflow <workflow-file> <command> [options]
 *
 * Commands:
 *   get <node-id>                    Get node by ID
 *   update <node-id> [options]       Update node
 *   delete <node-id>                 Delete node
 *   clone <node-id> <new-id>         Clone node with new ID
 *   export-node <node-id> <path>     Export node to JSON file
 *   move <node-id> --after <target>  Move node after target in array
 *   add <node-json-file>             Add nodes from JSON file
 *   search <text>                    Search nodes (supports regex: "a|b")
 *   list [--type <type>]             List all nodes (with type filter)
 *   structure [--graph]              Show workflow structure and connections
 *   validate                         Validate workflow
 *   get-variable <name>              Get declared global from variableRegistry
 *   set-variable <name> <value>      Set declared global in variableRegistry
 *   list-variables                   List all variables
 *   set-version <version>            Set workflow version
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowGraph, GraphNode } from "@mcp-moira/workflow-engine";
// Import GraphValidator directly to avoid auth dependencies from shared index
import { GraphValidator } from "@mcp-moira/workflow-engine/validation";
// Import directly from workflow-query-service to avoid auth dependencies
// Uses shared functions for CLI/MCP parity (DRY principle)
import {
  getWorkflowStructure,
  getNode,
  getWorkflowVariables,
  setWorkflowVariable,
  deleteWorkflowVariable,
  buildFlowGraph,
  // Shared functions for CLI/MCP parity
  listNodesCompact,
  analyzeVariableUsage,
  searchWorkflow,
  type SearchResult,
} from "@mcp-moira/shared/services/workflow-query-service";
import {
  validateVersionChange,
  isValidSemver,
  incrementPatchVersion,
  hasWorkflowContentChanged,
} from "@mcp-moira/shared/utils/version-utils";

// === CONFIGURATION ===
const MAX_DIRECTIVE_LENGTH = 150;
const MAX_CONDITION_LENGTH = 80;
const BACKUPS_DIR = path.join(process.cwd(), "workflow-backups");

// === COLORS ===
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

type ColorName = keyof typeof colors;

function c(color: ColorName, text: string | number): string {
  return `${colors[color]}${text}${colors.reset}`;
}

function getTypeColor(type: string): ColorName {
  const typeColors: Record<string, ColorName> = {
    start: "green",
    end: "red",
    "agent-directive": "blue",
    condition: "yellow",
    "telegram-notification": "magenta",
  };
  return typeColors[type] || "white";
}

// === BACKUP MANAGEMENT ===
function ensureBackupsDir(): void {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

function createBackup(filePath: string): string {
  ensureBackupsDir();

  const fileName = path.basename(filePath, ".json");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  const backupFileName = `${fileName}.backup-${timestamp}.json`;
  const backupPath = path.join(BACKUPS_DIR, backupFileName);

  fs.copyFileSync(filePath, backupPath);
  console.log(c("dim", `📦 Backup created: ${backupPath}`));
  return backupPath;
}

// === WORKFLOW LOADING ===
function loadWorkflow(filePath: string): WorkflowGraph {
  if (!fs.existsSync(filePath)) {
    console.error(c("red", `ERROR: File not found: ${filePath}`));
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as WorkflowGraph;
  } catch (error) {
    console.error(c("red", `ERROR: Failed to parse workflow file: ${(error as Error).message}`));
    process.exit(1);
  }
}

// === WORKFLOW SAVING ===
interface SaveOptions {
  force?: boolean; // Skip auto-increment (save without version change)
  skipVersionCheck?: boolean;
}

function saveWorkflow(
  filePath: string,
  workflow: WorkflowGraph,
  originalWorkflow?: WorkflowGraph,
  options: SaveOptions = {},
): void {
  // Auto-increment version if content changed (unless --force)
  if (originalWorkflow && !options.force && !options.skipVersionCheck) {
    const contentChanged = hasWorkflowContentChanged(originalWorkflow, workflow);

    if (contentChanged) {
      const currentVersion = workflow.metadata?.version;

      if (currentVersion && isValidSemver(currentVersion)) {
        const newVersion = incrementPatchVersion(currentVersion);
        workflow.metadata.version = newVersion;
        console.log(c("cyan", `✓ Version auto-incremented: ${currentVersion} → ${newVersion}`));
      } else {
        // Validate version format
        const validationResult = validateVersionChange(originalWorkflow, workflow);
        if (!validationResult.valid) {
          console.error(c("red", `ERROR: ${validationResult.error}`));
          process.exit(1);
        }
      }
    }
  }

  try {
    const content = JSON.stringify(workflow, null, 2);
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(c("green", `✓ Workflow saved: ${filePath}`));
  } catch (error) {
    console.error(c("red", `ERROR: Failed to save workflow: ${(error as Error).message}`));
    process.exit(1);
  }
}

// === GET COMMAND (uses shared service) ===
function cmdGetNode(workflow: WorkflowGraph, nodeId: string): void {
  const node = getNode(workflow, nodeId);

  if (!node) {
    console.error(c("red", `ERROR: Node not found: ${nodeId}`));
    process.exit(1);
  }

  console.log("");
  console.log(c("bright", `Node: ${nodeId}`));
  console.log(c("dim", "─".repeat(80)));
  console.log(JSON.stringify(node, null, 2));
  console.log("");
}

// === DELETE COMMAND ===
function deleteNode(workflow: WorkflowGraph, nodeId: string): WorkflowGraph {
  const nodeIndex = workflow.nodes.findIndex((n) => n.id === nodeId);

  if (nodeIndex === -1) {
    console.error(c("red", `ERROR: Node not found: ${nodeId}`));
    process.exit(1);
  }

  const deletedNode = workflow.nodes.splice(nodeIndex, 1)[0];

  console.log("");
  console.log(c("red", `✓ Deleted node: ${nodeId}`));
  console.log(c("dim", "─".repeat(80)));
  console.log(JSON.stringify(deletedNode, null, 2));
  console.log("");
  console.log(
    c(
      "yellow",
      "⚠ Warning: Connections pointing to this node still exist and will cause validation errors",
    ),
  );
  console.log("");

  return workflow;
}

// === CLONE COMMAND ===
function cloneNode(workflow: WorkflowGraph, nodeId: string, newId: string): WorkflowGraph {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) {
    console.error(c("red", `ERROR: Node not found: ${nodeId}`));
    process.exit(1);
  }

  const existingNode = workflow.nodes.find((n) => n.id === newId);
  if (existingNode) {
    console.error(c("red", `ERROR: Node already exists: ${newId}`));
    process.exit(1);
  }

  const clonedNode = JSON.parse(JSON.stringify(node));
  clonedNode.id = newId;
  workflow.nodes.push(clonedNode);

  console.log(c("green", `✓ Cloned node: ${nodeId} → ${newId}`));
  return workflow;
}

// === EXPORT NODE COMMAND ===
function exportNode(workflow: WorkflowGraph, nodeId: string, outputPath: string): void {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) {
    console.error(c("red", `ERROR: Node not found: ${nodeId}`));
    process.exit(1);
  }

  try {
    fs.writeFileSync(outputPath, JSON.stringify(node, null, 2), "utf-8");
    console.log(c("green", `✓ Exported node: ${nodeId} → ${outputPath}`));
  } catch (error) {
    console.error(c("red", `ERROR: Failed to write file: ${(error as Error).message}`));
    process.exit(1);
  }
}

// === MOVE COMMAND ===
function moveNode(workflow: WorkflowGraph, nodeId: string, afterNodeId: string): WorkflowGraph {
  const nodeIndex = workflow.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIndex === -1) {
    console.error(c("red", `ERROR: Node not found: ${nodeId}`));
    process.exit(1);
  }

  const afterIndex = workflow.nodes.findIndex((n) => n.id === afterNodeId);
  if (afterIndex === -1) {
    console.error(c("red", `ERROR: Target node not found: ${afterNodeId}`));
    process.exit(1);
  }

  const [node] = workflow.nodes.splice(nodeIndex, 1);
  const insertIndex = nodeIndex < afterIndex ? afterIndex : afterIndex + 1;
  workflow.nodes.splice(insertIndex, 0, node);

  console.log(c("green", `✓ Moved node: ${nodeId} → after ${afterNodeId}`));
  return workflow;
}

interface UpdateOptions {
  directive?: string;
  condition?: string;
  message?: string;
  inputSchema?: string;
  completionCondition?: string;
  connections?: string;
  addConnection?: { key: string; target: string };
  removeConnection?: string;
}

// === UPDATE COMMAND ===
function updateNode(
  workflow: WorkflowGraph,
  nodeId: string,
  options: UpdateOptions,
): WorkflowGraph {
  const nodeIndex = workflow.nodes.findIndex((n) => n.id === nodeId);

  if (nodeIndex === -1) {
    console.error(c("red", `ERROR: Node not found: ${nodeId}`));
    process.exit(1);
  }

  const node = workflow.nodes[nodeIndex] as GraphNode & Record<string, unknown>;
  let changes = 0;

  if (options.directive !== undefined) {
    node.directive = options.directive;
    changes++;
    console.log(c("green", `✓ Updated directive`));
  }

  if (options.condition !== undefined) {
    try {
      node.condition = JSON.parse(options.condition);
      changes++;
      console.log(c("green", `✓ Updated condition`));
    } catch {
      console.log(c("red", `✗ Invalid JSON in condition: ${options.condition}`));
      process.exit(1);
    }
  }

  if (options.message !== undefined) {
    node.message = options.message;
    changes++;
    console.log(c("green", `✓ Updated message`));
  }

  if (options.inputSchema !== undefined) {
    try {
      node.inputSchema = JSON.parse(options.inputSchema);
      changes++;
      console.log(c("green", `✓ Updated inputSchema`));
    } catch (error) {
      console.error(c("red", `ERROR: Invalid inputSchema JSON: ${(error as Error).message}`));
      process.exit(1);
    }
  }

  if (options.completionCondition !== undefined) {
    node.completionCondition = options.completionCondition;
    changes++;
    console.log(c("green", `✓ Updated completionCondition`));
  }

  if (options.connections !== undefined) {
    try {
      node.connections = JSON.parse(options.connections);
      changes++;
      console.log(c("green", `✓ Updated connections`));
    } catch (error) {
      console.error(c("red", `ERROR: Invalid connections JSON: ${(error as Error).message}`));
      process.exit(1);
    }
  }

  if (options.addConnection) {
    if (!node.connections) {
      node.connections = {};
    }
    node.connections[options.addConnection.key] = options.addConnection.target;
    changes++;
    console.log(
      c(
        "green",
        `✓ Added connection: ${options.addConnection.key} → ${options.addConnection.target}`,
      ),
    );
  }

  if (options.removeConnection) {
    if (node.connections && node.connections[options.removeConnection]) {
      delete node.connections[options.removeConnection];
      changes++;
      console.log(c("green", `✓ Removed connection: ${options.removeConnection}`));
    } else {
      console.log(c("yellow", `Connection not found: ${options.removeConnection}`));
    }
  }

  if (changes === 0) {
    console.log(
      c(
        "yellow",
        "No changes specified. Use --directive, --completion-condition, --input-schema, --condition, --message, --connections, or --add-connection",
      ),
    );
    process.exit(0);
  }

  console.log("");
  console.log(c("bright", `Updated node: ${nodeId}`));
  console.log(c("dim", "─".repeat(80)));
  console.log(JSON.stringify(node, null, 2));
  console.log("");

  return workflow;
}

// === ADD COMMAND ===
function addNodes(workflow: WorkflowGraph, nodeFilePath: string): WorkflowGraph {
  if (!fs.existsSync(nodeFilePath)) {
    console.error(c("red", `ERROR: File not found: ${nodeFilePath}`));
    process.exit(1);
  }

  let nodesToAdd: GraphNode[];
  try {
    const content = fs.readFileSync(nodeFilePath, "utf-8");
    const parsed = JSON.parse(content);
    nodesToAdd = Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    console.error(c("red", `ERROR: Failed to parse node file: ${(error as Error).message}`));
    process.exit(1);
  }

  const existingIds = new Set(workflow.nodes.map((n) => n.id));
  const conflicts = nodesToAdd.filter((n) => existingIds.has(n.id));

  if (conflicts.length > 0) {
    console.error(c("red", `ERROR: Node ID conflicts found:`));
    conflicts.forEach((n) => console.error(c("red", `  - ${n.id}`)));
    process.exit(1);
  }

  workflow.nodes.push(...nodesToAdd);

  console.log(c("green", `✓ Added ${nodesToAdd.length} node(s)`));
  nodesToAdd.forEach((n) => {
    console.log(c("dim", `  - ${n.id} (${n.type})`));
  });

  return workflow;
}

// === SEARCH COMMAND (uses shared service) ===
function cmdSearchNodes(workflow: WorkflowGraph, searchText: string): void {
  // Use shared searchWorkflow() for unified search with variable support
  const results = searchWorkflow(workflow, searchText, { includeVariables: true });

  const variableResults = results.filter((r): r is SearchResult => r.type === "variable");
  const nodeResults = results.filter((r): r is SearchResult => r.type === "node");

  console.log("");
  console.log(c("bright", `Search results for: "${searchText}"`));
  console.log(c("dim", "─".repeat(80)));
  console.log("");

  if (variableResults.length > 0) {
    console.log(c("magenta", "📋 Found in workflow variables:"));
    console.log("");
    variableResults.forEach((result) => {
      console.log(
        `${c("cyan", "●")} ${c("bright", `{{${result.variableName}}}`)} ${c("dim", "(workflow variable)")}`,
      );
      console.log(`    ${c("dim", "Matched in:")} ${result.matchedIn.join(", ")}`);
      if (result.snippet) {
        console.log(`    ${c("dim", "│")} ${result.snippet}`);
      }
      console.log("");
    });
  }

  if (nodeResults.length === 0) {
    if (variableResults.length === 0) {
      console.log(c("yellow", "No results found"));
    }
  } else {
    if (variableResults.length > 0) {
      console.log(c("blue", "🔧 Found in workflow nodes:"));
      console.log("");
    }

    nodeResults.forEach((result, index) => {
      const color = getTypeColor(result.nodeType || "unknown");
      console.log(
        `${c("gray", `[${index + 1}]`)} ${c(color, "●")} ${c("bright", result.nodeId)} ${c("dim", `(${result.nodeType})`)}`,
      );
      console.log(`    ${c("dim", "Matched in:")} ${result.matchedIn.join(", ")}`);

      if (result.snippet) {
        console.log(`    ${c("dim", "│")} ${result.snippet}`);
      }

      console.log("");
    });
  }

  console.log(
    c(
      "cyan",
      `Total: ${results.length} match(es) (${variableResults.length} in variables, ${nodeResults.length} in nodes)`,
    ),
  );
  console.log("");
}

// === LIST COMMAND (uses shared service) ===
function listNodes(workflow: WorkflowGraph, typeFilter?: string): void {
  // Use shared listNodesCompact() for consistent behavior with MCP
  const nodes = listNodesCompact(workflow, { typeFilter, includePreview: false });

  console.log("");
  if (typeFilter) {
    console.log(c("bright", `Nodes (type: ${typeFilter}):`));
  } else {
    console.log(c("bright", `All Nodes:`));
  }
  console.log(c("dim", "─".repeat(80)));
  console.log("");

  nodes.forEach((node, index) => {
    const color = getTypeColor(node.type);
    console.log(
      `${c("gray", `[${index + 1}]`)} ${c(color, "●")} ${c("bright", node.id)} ${c("dim", `(${node.type})`)}`,
    );

    if (node.connections.length > 0) {
      // Get original node to show connection keys
      const originalNode = workflow.nodes.find((n) => n.id === node.id);
      if (originalNode?.connections) {
        Object.entries(originalNode.connections).forEach(([key, target]) => {
          const arrow = key === "default" ? "→" : `→[${key}]`;
          console.log(`    ${c("gray", arrow)} ${target}`);
        });
      }
    }

    console.log("");
  });

  console.log(c("cyan", `Total: ${nodes.length} node(s)`));
  console.log("");
}

// === VARIABLES COMMAND (uses shared service) ===
function cmdShowVariables(workflow: WorkflowGraph, showUsage: boolean): void {
  // Use shared analyzeVariableUsage() for consistent behavior with MCP
  const analysis = analyzeVariableUsage(workflow);

  console.log("");
  console.log(c("bright", "═".repeat(80)));
  console.log(
    c("bright", `  Workflow Variables: ${workflow.metadata.name} v${workflow.metadata.version}`),
  );
  console.log(c("bright", "═".repeat(80)));
  console.log("");

  // Sort: initialData first, then inputSchema, then expression
  const sortedVars = Object.entries(analysis).sort((a, b) => {
    const aInit = a[1].sources.some((s) => s.type === "initialData");
    const bInit = b[1].sources.some((s) => s.type === "initialData");
    if (aInit !== bInit) return aInit ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });

  sortedVars.forEach(([varName, info]) => {
    const sourceTypes = [...new Set(info.sources.map((s) => s.type))];
    const usageCount = info.usages.length;

    // Get description from sources if available
    const description = info.sources.find((s) => s.description)?.description || "";

    // Color based on source type
    let color: ColorName = "white";
    let sourceLabel = "";
    if (sourceTypes.includes("initialData")) {
      color = "green";
      sourceLabel = "initial";
    } else if (sourceTypes.includes("inputSchema")) {
      color = "cyan";
      sourceLabel = "input";
    } else if (sourceTypes.includes("expression")) {
      color = "yellow";
      sourceLabel = "expr";
    }

    console.log(
      `${c(color, "●")} ${c("bright", varName)} ${c("dim", `[${sourceLabel}]`)} ${c("gray", `used ${usageCount}x`)}`,
    );

    if (description) {
      console.log(`  ${c("dim", description)}`);
    }

    if (showUsage && info.usages.length > 0) {
      console.log(`  ${c("dim", "Used in:")}`);
      const uniqueUsages = [...new Set(info.usages.map((u) => `${u.nodeId}:${u.field}`))];
      uniqueUsages.slice(0, 5).forEach((usage) => {
        console.log(`    ${c("gray", "→")} ${usage}`);
      });
      if (uniqueUsages.length > 5) {
        console.log(`    ${c("gray", `... and ${uniqueUsages.length - 5} more`)}`);
      }
    }

    console.log("");
  });

  console.log(c("cyan", `Total: ${c("bright", Object.keys(analysis).length)} variable(s)`));
  console.log("");
}

// === VARIABLE COMMANDS (uses shared service) ===
function cmdListVariables(workflow: WorkflowGraph): void {
  const variables = getWorkflowVariables(workflow);

  if (Object.keys(variables).length === 0) {
    console.log(c("yellow", "No declared globals found in variableRegistry"));
    return;
  }

  console.log(c("bright", "Workflow Variables:"));
  console.log(c("dim", "─".repeat(80)));

  Object.entries(variables).forEach(([name, varInfo]) => {
    const value = varInfo.value;
    const description = varInfo.description;
    const preview =
      typeof value === "string" && value.length > 100 ? value.substring(0, 100) + "..." : value;

    console.log(c("cyan", `${name}:`));
    console.log(`  ${c("dim", "Description:")} ${description}`);
    console.log(
      `  ${c("dim", "Value:")} ${typeof value === "string" ? preview : JSON.stringify(preview)}`,
    );
    console.log("");
  });

  console.log(c("cyan", `Total: ${c("bright", Object.keys(variables).length)} variable(s)`));
}

function cmdGetVariable(workflow: WorkflowGraph, varName: string): void {
  const variables = getWorkflowVariables(workflow);

  if (!(varName in variables)) {
    console.error(c("red", `ERROR: Variable not found: ${varName}`));
    process.exit(1);
  }

  const varInfo = variables[varName];
  console.log(c("bright", `Variable: ${varName}`));
  console.log(c("dim", "─".repeat(80)));
  console.log(c("dim", "Description:"), varInfo.description);
  console.log(c("dim", "Value:"), varInfo.value);
}

// Variable commands operate on the workflow variableRegistry (the single source of truth for
// declared globals). They delegate to the shared registry-aware service so the CLI and the MCP
// server stay in parity (DRY). The legacy start-node initialData.variables model is gone.

function setVariable(workflow: WorkflowGraph, varName: string, value: string): WorkflowGraph {
  const existing = getWorkflowVariables(workflow)[varName];
  const oldValue = existing?.value;

  // setWorkflowVariable preserves the existing description/type when the variable already
  // exists, otherwise infers the type and uses a placeholder description.
  const updated = setWorkflowVariable(workflow, varName, value);

  console.log(c("green", `✓ Set variable: ${varName}`));

  if (oldValue !== undefined && oldValue !== null) {
    const oldStr = typeof oldValue === "string" ? oldValue : JSON.stringify(oldValue);
    console.log(c("dim", "Old value:"));
    console.log(c("dim", oldStr.length > 100 ? oldStr.substring(0, 100) + "..." : oldStr));
  }

  console.log(c("bright", "\nNew value:"));
  console.log(value.length > 100 ? value.substring(0, 100) + "..." : value);

  return updated;
}

function deleteVariable(workflow: WorkflowGraph, varName: string): WorkflowGraph {
  const existing = getWorkflowVariables(workflow)[varName];

  if (!existing) {
    console.error(c("red", `ERROR: Variable not found: ${varName}`));
    process.exit(1);
  }

  const updated = deleteWorkflowVariable(workflow, varName);

  console.log(c("green", `✓ Deleted variable: ${varName}`));
  console.log(c("dim", `Description: ${existing.description}`));
  if (existing.value !== undefined && existing.value !== null) {
    const valStr =
      typeof existing.value === "string" ? existing.value : JSON.stringify(existing.value);
    console.log(
      c("dim", `Value: ${valStr.length > 100 ? valStr.substring(0, 100) + "..." : valStr}`),
    );
  }

  return updated;
}

function setVersion(workflow: WorkflowGraph, version: string): WorkflowGraph {
  if (!workflow.metadata) {
    workflow.metadata = { name: "", version: "", description: "" };
  }

  const oldVersion = workflow.metadata.version;
  workflow.metadata.version = version;

  console.log(c("green", `✓ Version updated: ${oldVersion || "none"} → ${version}`));

  return workflow;
}

// === VALIDATE COMMAND (uses full GraphValidator with JSON Schema) ===
async function cmdValidateWorkflow(workflow: WorkflowGraph): Promise<void> {
  const validator = new GraphValidator();
  const result = await validator.validateUnified(workflow);

  console.log("");
  console.log(c("bright", "Workflow Validation"));
  console.log(c("dim", "─".repeat(80)));
  console.log("");

  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");

  if (errors.length > 0) {
    console.log(c("red", `✗ ${errors.length} error(s) found:`));
    errors.forEach((err) => console.log(`  ${c("red", "•")} ${err.message}`));
    console.log("");
  }

  if (warnings.length > 0) {
    console.log(c("yellow", `⚠ ${warnings.length} warning(s):`));
    warnings.forEach((warn) => console.log(`  ${c("yellow", "•")} ${warn.message}`));
    console.log("");
  }

  if (result.valid && warnings.length === 0) {
    console.log(c("green", "✓ Workflow is valid"));
    console.log("");
  }
}

interface StructureConfig {
  showGraph: boolean;
  detailed: boolean;
  typeFilter?: string;
}

// === STRUCTURE COMMAND (uses shared service) ===
function showStructure(workflow: WorkflowGraph, config: StructureConfig): void {
  const structure = getWorkflowStructure(workflow);

  console.log("");
  console.log(c("bright", "═".repeat(80)));
  console.log(c("bright", `  ${structure.metadata.name} v${structure.metadata.version}`));
  console.log(c("bright", "═".repeat(80)));
  console.log("");

  console.log(c("cyan", "Metadata:"));
  console.log(`  ID: ${c("yellow", structure.id)}`);
  console.log(`  Description: ${structure.metadata.description}`);
  if (structure.metadata.author) {
    console.log(`  Author: ${structure.metadata.author}`);
  }
  if (structure.metadata.tags) {
    console.log(`  Tags: ${structure.metadata.tags.join(", ")}`);
  }
  console.log("");

  console.log(c("cyan", `Nodes: ${c("bright", structure.stats.totalNodes)} total`));
  Object.entries(structure.stats.byType)
    .sort(([, a], [, b]) => b - a)
    .forEach(([type, count]) => {
      const color = getTypeColor(type);
      console.log(`  ${c(color, "●")} ${type}: ${c("bright", count)}`);
    });
  console.log("");

  const filteredNodes = config.typeFilter
    ? workflow.nodes.filter((n) => n.type === config.typeFilter)
    : workflow.nodes;

  if (config.typeFilter) {
    console.log(c("cyan", `Nodes (filtered by type: ${config.typeFilter}):`));
  } else {
    console.log(c("cyan", "Nodes:"));
  }
  console.log("");

  filteredNodes.forEach((node, index) => {
    const color = getTypeColor(node.type);
    console.log(
      `${c("gray", `[${index + 1}]`)} ${c(color, "●")} ${c("bright", node.id)} ${c("dim", `(${node.type})`)}`,
    );

    if (node.connections) {
      Object.entries(node.connections).forEach(([key, target]) => {
        const arrow = key === "default" ? "→" : `→[${key}]`;
        console.log(`    ${c("gray", arrow)} ${target}`);
      });
    }

    if (config.detailed) {
      if ("directive" in node && node.directive) {
        const directive =
          (node.directive as string).length > MAX_DIRECTIVE_LENGTH
            ? (node.directive as string).substring(0, MAX_DIRECTIVE_LENGTH) + "..."
            : (node.directive as string);
        console.log(`    ${c("dim", "Directive:")} ${directive.split("\n")[0]}`);
      }

      if ("condition" in node && node.condition) {
        const condition =
          String(node.condition).length > MAX_CONDITION_LENGTH
            ? String(node.condition).substring(0, MAX_CONDITION_LENGTH) + "..."
            : String(node.condition);
        console.log(`    ${c("dim", "Condition:")} ${condition}`);
      }

      if ("message" in node && node.message) {
        const message = (node.message as string).split("\n")[0];
        console.log(`    ${c("dim", "Message:")} ${message}`);
      }

      if ("inputSchema" in node && node.inputSchema) {
        const schema = node.inputSchema as { properties?: Record<string, unknown> };
        const props = Object.keys(schema.properties || {});
        if (props.length > 0) {
          console.log(`    ${c("dim", "Inputs:")} ${props.join(", ")}`);
        }
      }
    }

    console.log("");
  });

  if (config.showGraph) {
    console.log("");
    console.log(c("bright", "─".repeat(80)));
    console.log(c("cyan", "Flow Graph:"));
    console.log("");
    const graphLines = buildFlowGraph(workflow);
    graphLines.forEach((line) => console.log(line));
  }
}

// === DIFF COMMAND ===
function cmdDiff(workflow1: WorkflowGraph, workflow2Path: string): void {
  const workflow2 = loadWorkflow(workflow2Path);

  console.log("");
  console.log(c("bright", "Workflow Comparison"));
  console.log(c("dim", "─".repeat(80)));
  console.log("");

  // Compare metadata
  const metadataChanges: string[] = [];
  if (workflow1.metadata.name !== workflow2.metadata.name) {
    metadataChanges.push(`name: "${workflow1.metadata.name}" → "${workflow2.metadata.name}"`);
  }
  if (workflow1.metadata.version !== workflow2.metadata.version) {
    metadataChanges.push(
      `version: "${workflow1.metadata.version}" → "${workflow2.metadata.version}"`,
    );
  }
  if (workflow1.metadata.description !== workflow2.metadata.description) {
    metadataChanges.push(`description changed`);
  }

  if (metadataChanges.length > 0) {
    console.log(c("yellow", "📋 Metadata changes:"));
    metadataChanges.forEach((change) => console.log(`  ${change}`));
    console.log("");
  }

  // Compare nodes
  const nodes1Map = new Map(workflow1.nodes.map((n) => [n.id, n]));
  const nodes2Map = new Map(workflow2.nodes.map((n) => [n.id, n]));

  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const modifiedNodes: Array<{ id: string; changes: string[] }> = [];

  // Find added nodes
  for (const [id] of nodes2Map) {
    if (!nodes1Map.has(id)) {
      addedNodes.push(id);
    }
  }

  // Find removed nodes
  for (const [id] of nodes1Map) {
    if (!nodes2Map.has(id)) {
      removedNodes.push(id);
    }
  }

  // Find modified nodes
  for (const [id, node1] of nodes1Map) {
    const node2 = nodes2Map.get(id);
    if (node2) {
      const changes: string[] = [];
      if (node1.type !== node2.type) changes.push("type");
      if (JSON.stringify(node1.connections) !== JSON.stringify(node2.connections))
        changes.push("connections");
      if ("directive" in node1 && "directive" in node2 && node1.directive !== node2.directive)
        changes.push("directive");
      if (
        "completionCondition" in node1 &&
        "completionCondition" in node2 &&
        node1.completionCondition !== node2.completionCondition
      )
        changes.push("completionCondition");
      if (
        "inputSchema" in node1 &&
        "inputSchema" in node2 &&
        JSON.stringify(node1.inputSchema) !== JSON.stringify(node2.inputSchema)
      )
        changes.push("inputSchema");
      if (
        "condition" in node1 &&
        "condition" in node2 &&
        JSON.stringify(node1.condition) !== JSON.stringify(node2.condition)
      )
        changes.push("condition");
      if ("message" in node1 && "message" in node2 && node1.message !== node2.message)
        changes.push("message");
      if (
        "initialData" in node1 &&
        "initialData" in node2 &&
        JSON.stringify(node1.initialData) !== JSON.stringify(node2.initialData)
      )
        changes.push("initialData");

      if (changes.length > 0) {
        modifiedNodes.push({ id, changes });
      }
    }
  }

  if (addedNodes.length > 0) {
    console.log(c("green", `➕ Added nodes (${addedNodes.length}):`));
    addedNodes.forEach((id) => console.log(`  ${c("green", "+")} ${id}`));
    console.log("");
  }

  if (removedNodes.length > 0) {
    console.log(c("red", `➖ Removed nodes (${removedNodes.length}):`));
    removedNodes.forEach((id) => console.log(`  ${c("red", "-")} ${id}`));
    console.log("");
  }

  if (modifiedNodes.length > 0) {
    console.log(c("yellow", `✏️  Modified nodes (${modifiedNodes.length}):`));
    modifiedNodes.forEach(({ id, changes }) => {
      console.log(`  ${c("yellow", "~")} ${id}: ${changes.join(", ")}`);
    });
    console.log("");
  }

  // Compare systemReminder
  if (workflow1.systemReminder !== workflow2.systemReminder) {
    console.log(c("magenta", "📝 systemReminder changed"));
    console.log("");
  }

  // Summary
  const totalChanges =
    metadataChanges.length +
    addedNodes.length +
    removedNodes.length +
    modifiedNodes.length +
    (workflow1.systemReminder !== workflow2.systemReminder ? 1 : 0);

  if (totalChanges === 0) {
    console.log(c("green", "✓ Workflows are identical"));
  } else {
    console.log(c("cyan", `Total: ${totalChanges} difference(s)`));
  }
  console.log("");
}

// === CREATE COMMAND ===
interface CreateOptions {
  name: string;
  description?: string;
  version?: string;
  template?: string;
}

function createWorkflow(outputPath: string, options: CreateOptions): void {
  if (fs.existsSync(outputPath)) {
    console.error(c("red", `ERROR: File already exists: ${outputPath}`));
    process.exit(1);
  }

  let workflow: WorkflowGraph;

  if (options.template) {
    // Copy from template
    const templateWorkflow = loadWorkflow(options.template);
    workflow = JSON.parse(JSON.stringify(templateWorkflow));
    workflow.id = `workflow-${Date.now()}`;
    workflow.metadata.name = options.name;
    if (options.description) {
      workflow.metadata.description = options.description;
    }
    if (options.version) {
      workflow.metadata.version = options.version;
    }
  } else {
    // Create minimal workflow
    workflow = {
      id: `workflow-${Date.now()}`,
      metadata: {
        name: options.name,
        version: options.version || "1.0.0",
        description: options.description || "",
      },
      nodes: [
        {
          id: "start",
          type: "start",
          connections: { default: "end" },
          initialData: {
            variables: {},
          },
        },
        {
          id: "end",
          type: "end",
        },
      ],
    } as WorkflowGraph;
  }

  saveWorkflow(outputPath, workflow);
  console.log(c("green", `✓ Created workflow: ${options.name}`));
  console.log(c("dim", `  ID: ${workflow.id}`));
  console.log(c("dim", `  Nodes: ${workflow.nodes.length}`));
}

// === COPY COMMAND ===
function copyWorkflow(sourcePath: string, destPath: string, newName?: string): void {
  if (fs.existsSync(destPath)) {
    console.error(c("red", `ERROR: Destination file already exists: ${destPath}`));
    process.exit(1);
  }

  const sourceWorkflow = loadWorkflow(sourcePath);
  const copiedWorkflow: WorkflowGraph = JSON.parse(JSON.stringify(sourceWorkflow));

  // Generate new ID
  copiedWorkflow.id = `${sourceWorkflow.id}-copy-${Date.now()}`;

  // Update name if provided
  if (newName) {
    copiedWorkflow.metadata.name = newName;
  } else {
    copiedWorkflow.metadata.name = `${sourceWorkflow.metadata.name} (copy)`;
  }

  saveWorkflow(destPath, copiedWorkflow);
  console.log(c("green", `✓ Copied workflow: ${sourceWorkflow.metadata.name}`));
  console.log(c("dim", `  Source: ${sourcePath}`));
  console.log(c("dim", `  Destination: ${destPath}`));
  console.log(c("dim", `  New ID: ${copiedWorkflow.id}`));
  console.log(c("dim", `  New Name: ${copiedWorkflow.metadata.name}`));
}

// === ARGUMENT PARSING ===
interface ParsedConfig {
  file: string;
  command: string;
  nodeId?: string;
  options: UpdateOptions & { typeFilter?: string };
  showGraph: boolean;
  detailed: boolean;
  typeFilter?: string;
  force: boolean;
}

function parseArgs(): ParsedConfig {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
${c("bright", "Workflow Management Tool")}

${c("cyan", "Usage:")}
  npm run workflow <workflow-file> <command> [options]

${c("cyan", "Commands:")}
  get <node-id>                    Get node by ID
  update <node-id> [options]       Update node
  delete <node-id>                 Delete node
  clone <node-id> <new-id>         Clone node with new ID
  export-node <node-id> <path>     Export node to JSON file
  move <node-id> --after <target>  Move node after target in array
  add <node-json-file>             Add nodes from JSON file
  search <text>                    Search nodes (supports regex: "a|b")
  list [--type <type>]             List all nodes (with type filter)
  structure [--graph] [--detailed] Show workflow structure
  validate                         Validate workflow
  variables [--usage]              Analyze all workflow variables
  get-variable <name>              Get declared global from variableRegistry
  set-variable <name> <value>      Set declared global in variableRegistry
  delete-variable <name>           Delete declared global from variableRegistry
  list-variables                   List all variables
  set-version <version>            Set workflow version
  diff <other-file>                Compare with another workflow file
  create <file> --name <name>      Create new workflow
  copy <dest-file> [--name <name>] Copy workflow to new file

${c("cyan", "Update Options:")}
  --directive "text"                   Update directive
  --directive-file <path>              Update directive from file
  --completion-condition "text"        Update completionCondition
  --input-schema '{"type":"object"}'   Update inputSchema
  --condition "expression"             Update condition
  --message "text"                     Update message
  --connections '{"key":"target"}'     Update connections
  --add-connection <key> <target>      Add connection
  --remove-connection <key>            Remove connection by key

${c("cyan", "Structure Options:")}
  --graph                              Show flow graph
  --detailed                           Show detailed information
  --type <type>                        Filter by node type

${c("cyan", "Version Validation:")}
  Content changes require version increment (semver X.Y.Z format).
  Use --force to bypass version check for emergencies.

${c("cyan", "Examples:")}
  npm run workflow dev-flow.json get analyze-and-plan
  npm run workflow dev-flow.json update analyze-and-plan --directive "новый текст"
  npm run workflow dev-flow.json search "development-plan.md"
  npm run workflow dev-flow.json search "restart|verify"
  npm run workflow dev-flow.json list --type agent-directive
  npm run workflow dev-flow.json structure --graph
  npm run workflow dev-flow.json validate
`);
    process.exit(0);
  }

  // Special case: create command where first arg is command, not file
  let file: string;
  let command: string;
  let nodeId: string | undefined;

  if (args[0] === "create") {
    // npm run workflow create <output-file> --name <name>
    command = "create";
    file = args[1]; // output file path
    nodeId = undefined;
  } else {
    // Normal case: npm run workflow <file> <command> [args]
    file = args[0];
    command = args[1];
    nodeId = args[2];
  }

  const config: ParsedConfig = {
    file,
    command,
    nodeId,
    options: {},
    showGraph: args.includes("--graph"),
    detailed: args.includes("--detailed"),
    typeFilter: undefined,
    force: args.includes("--force"),
  };

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--directive" && args[i + 1]) {
      config.options.directive = args[i + 1];
      i++;
    } else if (args[i] === "--directive-file" && args[i + 1]) {
      const filePath = args[i + 1];
      if (!fs.existsSync(filePath)) {
        console.error(c("red", `ERROR: Directive file not found: ${filePath}`));
        process.exit(1);
      }
      config.options.directive = fs.readFileSync(filePath, "utf-8").trim();
      i++;
    } else if (args[i] === "--condition" && args[i + 1]) {
      config.options.condition = args[i + 1];
      i++;
    } else if (args[i] === "--message" && args[i + 1]) {
      config.options.message = args[i + 1];
      i++;
    } else if (args[i] === "--input-schema" && args[i + 1]) {
      config.options.inputSchema = args[i + 1];
      i++;
    } else if (args[i] === "--completion-condition" && args[i + 1]) {
      config.options.completionCondition = args[i + 1];
      i++;
    } else if (args[i] === "--connections" && args[i + 1]) {
      config.options.connections = args[i + 1];
      i++;
    } else if (args[i] === "--add-connection" && args[i + 1] && args[i + 2]) {
      config.options.addConnection = {
        key: args[i + 1],
        target: args[i + 2],
      };
      i += 2;
    } else if (args[i] === "--remove-connection" && args[i + 1]) {
      config.options.removeConnection = args[i + 1];
      i++;
    } else if (args[i] === "--type" && args[i + 1]) {
      config.options.typeFilter = args[i + 1];
      config.typeFilter = args[i + 1];
      i++;
    }
  }

  return config;
}

// === MAIN ===
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = parseArgs();

  // Handle create command separately - it doesn't require existing file
  if (config.command === "create") {
    const nameIdx = args.indexOf("--name");
    if (nameIdx === -1 || !args[nameIdx + 1]) {
      console.error(c("red", "ERROR: Missing --name for create command"));
      console.log("Usage: npm run workflow create <file> --name <name>");
      process.exit(1);
    }
    const descIdx = args.indexOf("--description");
    const versionIdx = args.indexOf("--version");
    const templateIdx = args.indexOf("--template");
    createWorkflow(config.file, {
      name: args[nameIdx + 1],
      description: descIdx !== -1 ? args[descIdx + 1] : undefined,
      version: versionIdx !== -1 ? args[versionIdx + 1] : undefined,
      template: templateIdx !== -1 ? args[templateIdx + 1] : undefined,
    });
    return;
  }

  const workflow = loadWorkflow(config.file);
  // Deep copy for version comparison (needed for commands that modify workflow)
  const originalWorkflow: WorkflowGraph = JSON.parse(JSON.stringify(workflow));
  const saveOptions: SaveOptions = { force: config.force };

  switch (config.command) {
    case "get":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing node-id for get command"));
        process.exit(1);
      }
      cmdGetNode(workflow, config.nodeId);
      break;

    case "add":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing node-json-file for add command"));
        process.exit(1);
      }
      createBackup(config.file);
      saveWorkflow(config.file, addNodes(workflow, config.nodeId), originalWorkflow, saveOptions);
      break;

    case "update":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing node-id for update command"));
        process.exit(1);
      }
      createBackup(config.file);
      saveWorkflow(
        config.file,
        updateNode(workflow, config.nodeId, config.options),
        originalWorkflow,
        saveOptions,
      );
      break;

    case "delete":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing node-id for delete command"));
        process.exit(1);
      }
      createBackup(config.file);
      saveWorkflow(config.file, deleteNode(workflow, config.nodeId), originalWorkflow, saveOptions);
      break;

    case "clone":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing source node-id for clone command"));
        process.exit(1);
      }
      if (!args[3]) {
        console.error(c("red", "ERROR: Missing new node-id for clone command"));
        process.exit(1);
      }
      createBackup(config.file);
      saveWorkflow(
        config.file,
        cloneNode(workflow, config.nodeId, args[3]),
        originalWorkflow,
        saveOptions,
      );
      break;

    case "export-node":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing node-id for export-node command"));
        process.exit(1);
      }
      if (!args[3]) {
        console.error(c("red", "ERROR: Missing output path for export-node command"));
        process.exit(1);
      }
      exportNode(workflow, config.nodeId, args[3]);
      break;

    case "move": {
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing node-id for move command"));
        process.exit(1);
      }
      const afterIdx = args.indexOf("--after");
      if (afterIdx === -1 || !args[afterIdx + 1]) {
        console.error(c("red", "ERROR: Missing --after <target-id> for move command"));
        process.exit(1);
      }
      createBackup(config.file);
      saveWorkflow(
        config.file,
        moveNode(workflow, config.nodeId, args[afterIdx + 1]),
        originalWorkflow,
        saveOptions,
      );
      break;
    }

    case "search":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing search text"));
        process.exit(1);
      }
      cmdSearchNodes(workflow, config.nodeId);
      break;

    case "list":
      listNodes(workflow, config.options.typeFilter);
      break;

    case "structure":
      showStructure(workflow, config);
      break;

    case "list-variables":
      cmdListVariables(workflow);
      break;

    case "get-variable":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing variable name"));
        process.exit(1);
      }
      cmdGetVariable(workflow, config.nodeId);
      break;

    case "set-variable":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing variable name"));
        process.exit(1);
      }
      if (!config.options.directive && args.length < 4) {
        console.error(c("red", "ERROR: Missing variable value"));
        console.log("Usage: set-variable <name> <value>");
        process.exit(1);
      }
      createBackup(config.file);
      saveWorkflow(
        config.file,
        setVariable(workflow, config.nodeId, config.options.directive || args.slice(3).join(" ")),
        originalWorkflow,
        saveOptions,
      );
      break;

    case "set-version": {
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing version"));
        process.exit(1);
      }
      // Validate semver format before setting
      if (!isValidSemver(config.nodeId)) {
        console.error(
          c("red", `ERROR: Invalid semver version: "${config.nodeId}". Must be in X.Y.Z format.`),
        );
        process.exit(1);
      }
      createBackup(config.file);
      // Skip version check for set-version command (it's intentionally changing version)
      saveWorkflow(config.file, setVersion(workflow, config.nodeId), originalWorkflow, {
        ...saveOptions,
        skipVersionCheck: true,
      });
      break;
    }

    case "validate":
      await cmdValidateWorkflow(workflow);
      break;

    case "variables":
      cmdShowVariables(workflow, args.includes("--usage"));
      break;

    case "diff":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing comparison file"));
        console.log("Usage: npm run workflow <file1> diff <file2>");
        process.exit(1);
      }
      cmdDiff(workflow, config.nodeId);
      break;

    case "delete-variable":
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing variable name"));
        process.exit(1);
      }
      createBackup(config.file);
      saveWorkflow(
        config.file,
        deleteVariable(workflow, config.nodeId),
        originalWorkflow,
        saveOptions,
      );
      break;

    case "copy": {
      if (!config.nodeId) {
        console.error(c("red", "ERROR: Missing destination file for copy command"));
        console.log("Usage: npm run workflow <source-file> copy <dest-file> [--name <name>]");
        process.exit(1);
      }
      const copyNameIdx = args.indexOf("--name");
      const newName = copyNameIdx !== -1 ? args[copyNameIdx + 1] : undefined;
      copyWorkflow(config.file, config.nodeId, newName);
      break;
    }

    default:
      console.error(c("red", `ERROR: Unknown command: ${config.command}`));
      console.log("Run with --help to see available commands");
      process.exit(1);
  }
}

main();
