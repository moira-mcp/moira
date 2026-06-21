/**
 * Scenario-based Workflow Test Runner
 * Uses GraphExecutionEngine directly for accurate node tracking
 *
 * ## Directive Validation (Issue #449)
 *
 * After each step execution, validates rendered directives for:
 * - **Unrendered templates**: `{{variable}}`, `{{#if}}`, `{{/if}}` remaining in output
 * - **Null values**: Literal "null" string indicating undefined variable
 *
 * This catches workflow design errors at test time:
 * - Missing variables in initialData
 * - Typos in variable names
 * - Unclosed conditional blocks
 * - Variables used before they're defined by previous nodes
 *
 * Example failures:
 * ```
 * Error: Unrendered template in node 'task' directive: {{undefined_var}}
 * Error: Suspicious 'null' value in node 'task' directive: "...value is null..."
 * ```
 *
 * ## Input Validation (Fail-Fast)
 *
 * When mockInput doesn't match node's inputSchema, the runner:
 * - Detects validation error immediately (no 100-iteration loops)
 * - Throws with clear diagnostics: provided input, expected format, fix hint
 * - Reports which field is missing or wrong
 *
 * Example failure:
 * ```
 * Input validation failed for node 'get-action-type'
 *
 * PROVIDED MOCK INPUT:
 * { "action_type": "create" }
 *
 * EXPECTED FORMAT:
 * { "action_type": "string (required)", "has_web_access": "boolean (required)" }
 *
 * FIX: Update mockInputs['get-action-type'] in your test scenario to match the schema.
 * ```
 *
 * ## Loop Detection
 *
 * If scenario hits maxSteps limit, provides diagnostics:
 * - Detected loop pattern (e.g., "A → B → A")
 * - Most repeated nodes with visit counts
 * - Nodes visited without mockInput defined
 * - Unused mockInputs (never reached)
 */

import {
  GraphExecutionEngine,
  InMemoryRepository,
  AgentMessageQueue,
  AgentMessageType,
  GraphTemplateProcessor,
  type WorkflowGraph,
  type ExecutionContext,
  type DirectiveMessage,
} from "@mcp-moira/workflow-engine";
import { randomUUID } from "crypto";

/**
 * User ID used by scenario runner for workflow execution.
 * Tests that need database access (e.g., write-note nodes) must ensure
 * this user exists in the database before running scenarios.
 */
export const TEST_USER_ID = "workflow-test-user";
const MAX_STEPS_DEFAULT = 100;

/**
 * Context passed to dynamic mock input functions
 */
export interface MockInputContext {
  variables: Record<string, unknown>;
  visitCount: number; // How many times this node has been visited
  nodeId: string;
}

/**
 * Mock input can be:
 * - A static object (used as-is)
 * - A function that receives context and returns the input
 * - An array of objects (used in order for each visit)
 */
export type MockInput =
  | Record<string, unknown>
  | ((ctx: MockInputContext) => Record<string, unknown>)
  | Record<string, unknown>[];

/**
 * Test scenario format
 */
export interface TestScenario {
  name: string;
  description?: string;
  mockInputs: Record<string, MockInput>;
  expect: ScenarioExpectations;
  /**
   * Teleport jump configuration: after visiting a node, jump to a teleport node.
   * Format: { afterNode: "node-id", visitNumber: 1, teleportTo: "teleport-node-id" }
   * The jump happens AFTER the specified node visit instead of following normal connections.
   */
  teleportAfter?: {
    afterNode: string;
    visitNumber?: number; // defaults to 1 (first visit)
    teleportTo: string;
  };
}

export interface ScenarioExpectations {
  reaches?: string[];
  avoids?: string[];
  maxSteps?: number;
  status?: "completed" | "failed";
  contextContains?: Record<string, unknown>;
}

export interface ScenarioResult {
  scenario: string;
  passed: boolean;
  visitedNodes: string[];
  finalContext: Record<string, unknown>;
  stepCount: number;
  executionTime: number;
  status: "completed" | "failed" | "running" | "waiting";
  error?: string;
  failedExpectations?: string[];
  /** Diagnostic info when scenario hits max steps (likely loop) */
  loopDiagnostics?: LoopDiagnostics;
}

/**
 * Diagnostics for scenarios that hit max steps limit
 */
export interface LoopDiagnostics {
  /** Last N nodes visited before hitting limit */
  lastNodes: string[];
  /** Node visit frequency - how many times each node was visited */
  visitCounts: Record<string, number>;
  /** Nodes visited more than once (potential loop participants) */
  repeatedNodes: string[];
  /** Nodes in mockInputs that were never visited */
  unusedMockInputs: string[];
  /** Nodes visited that have no mockInput defined */
  missingMockInputs: string[];
  /** Detected loop pattern if any */
  detectedLoop?: string;
}

/**
 * Options for runScenario
 */
export interface RunScenarioOptions {
  /** Callback to customize engine after creation (e.g., override node handlers for testing) */
  engineSetup?: (engine: GraphExecutionEngine) => void;
}

/**
 * Run a single scenario against a workflow
 */
export async function runScenario(
  workflow: WorkflowGraph,
  scenario: TestScenario,
  options?: RunScenarioOptions,
): Promise<ScenarioResult> {
  const startTime = Date.now();
  const allVisitedNodes: string[] = [];
  const maxSteps = scenario.expect.maxSteps ?? MAX_STEPS_DEFAULT;

  // Create fresh repository and engine for each scenario
  const repository = new InMemoryRepository();
  const engine = new GraphExecutionEngine(repository);

  // Allow test-specific engine customization (e.g., injecting mock NoteService)
  if (options?.engineSetup) {
    options.engineSetup(engine);
  }

  // Save workflow
  await repository.saveWorkflow(workflow, TEST_USER_ID);

  // Find start node
  const startNode = workflow.nodes.find((n) => n.type === "start");
  if (!startNode) {
    return {
      scenario: scenario.name,
      passed: false,
      visitedNodes: [],
      finalContext: {},
      stepCount: 0,
      executionTime: Date.now() - startTime,
      status: "failed",
      error: "No start node found",
    };
  }

  // Create initial context
  const executionId = randomUUID();
  let context: ExecutionContext = {
    variables: {},
    nodeStates: {},
    executionId,
    workflowId: workflow.id,
    userId: TEST_USER_ID,
  };

  // Track how many times each node has been visited (for dynamic mock inputs)
  const nodeVisitCounts: Record<string, number> = {};

  try {
    let stepCount = 0;
    let currentNodeId = startNode.id;
    let status: "running" | "waiting" | "completed" | "failed" = "running";
    let teleportFired = false;

    // Execute steps until completion or max steps
    while (stepCount < maxSteps && status !== "completed" && status !== "failed") {
      const messageQueue = new AgentMessageQueue();

      // Check maxRetries: if current node has been visited maxRetries times, redirect to maxRetriesExceeded
      const currentNodeDef = workflow.nodes.find((n) => n.id === currentNodeId);
      if (
        currentNodeDef &&
        currentNodeDef.type === "agent-directive" &&
        "maxRetries" in currentNodeDef &&
        typeof currentNodeDef.maxRetries === "number" &&
        (nodeVisitCounts[currentNodeId] || 0) >= currentNodeDef.maxRetries
      ) {
        const connections = currentNodeDef.connections as Record<string, string>;
        const maxRetriesTarget = connections?.maxRetriesExceeded;
        if (maxRetriesTarget) {
          allVisitedNodes.push(currentNodeId);
          currentNodeId = maxRetriesTarget;
          stepCount++;
          continue;
        }
      }

      // Get mock input for current node, supporting dynamic inputs
      const mockInput = resolveMockInput(
        scenario.mockInputs[currentNodeId],
        currentNodeId,
        context.variables as Record<string, unknown>,
        nodeVisitCounts,
      );

      // Increment visit count for this node
      nodeVisitCounts[currentNodeId] = (nodeVisitCounts[currentNodeId] || 0) + 1;

      // Execute graph from current node
      const result = await engine.executeGraph(
        workflow,
        context,
        messageQueue,
        currentNodeId,
        mockInput,
      );

      // Check for input validation errors - fail fast instead of looping
      checkForValidationError(messageQueue, currentNodeId, mockInput);

      // Validate rendered directives - check for unrendered templates
      validateRenderedDirectives(messageQueue, currentNodeId);

      // Track visited nodes - include ALL visits to capture branch transitions
      // Coverage calculator relies on consecutive node pairs to determine branches
      if (result.visitedNodes) {
        for (const nodeId of result.visitedNodes) {
          allVisitedNodes.push(nodeId);
        }
      }

      // Update context
      context = result.context;

      // Handle result
      switch (result.action) {
        case "complete":
          status = "completed";
          break;
        case "error":
          status = "failed";
          break;
        case "pause":
          if (result.nextNodeId) {
            currentNodeId = result.nextNodeId;
          } else {
            status = "failed";
          }
          break;
      }

      // Check for teleport jump: after visiting specified node, redirect to teleport target
      // Uses a one-shot flag to ensure teleport fires exactly once
      if (
        scenario.teleportAfter &&
        !teleportFired &&
        result.action === "pause" &&
        status !== "failed"
      ) {
        const { afterNode, visitNumber = 1, teleportTo } = scenario.teleportAfter;
        // Count how many times afterNode appeared in ALL visited nodes so far
        const totalVisits = allVisitedNodes.filter((id) => id === afterNode).length;
        if (totalVisits >= visitNumber) {
          currentNodeId = teleportTo;
          teleportFired = true;
        }
      }

      stepCount++;
    }

    const finalContext = context.variables as Record<string, unknown>;

    // Check expectations
    const failedExpectations = checkExpectations(
      scenario.expect,
      allVisitedNodes,
      finalContext,
      status,
    );

    // Generate loop diagnostics if we hit max steps
    let loopDiagnostics: LoopDiagnostics | undefined;
    let loopError: string | undefined;
    if (stepCount >= maxSteps && status === "running") {
      loopDiagnostics = generateLoopDiagnostics(
        allVisitedNodes,
        nodeVisitCounts,
        Object.keys(scenario.mockInputs),
      );
      loopError = formatLoopError(loopDiagnostics, maxSteps);
    }

    return {
      scenario: scenario.name,
      passed: failedExpectations.length === 0 && !loopError,
      visitedNodes: allVisitedNodes,
      finalContext,
      stepCount,
      executionTime: Date.now() - startTime,
      status,
      error: loopError,
      failedExpectations: failedExpectations.length > 0 ? failedExpectations : undefined,
      loopDiagnostics,
    };
  } catch (error) {
    // Include stack trace for debugging
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    return {
      scenario: scenario.name,
      passed: false,
      visitedNodes: allVisitedNodes,
      finalContext: {},
      stepCount: 0,
      executionTime: Date.now() - startTime,
      status: "failed",
      error: errorStack ? `${errorMessage}\n\nStack trace:\n${errorStack}` : errorMessage,
    };
  }
}

/**
 * Resolve mock input based on type:
 * - undefined: return empty object (Issue #369: nodes without inputSchema accept only empty input)
 * - function: call with context
 * - array: return element by visit count (cycling if needed)
 * - object: return as-is
 */
function resolveMockInput(
  mockInput: MockInput | undefined,
  nodeId: string,
  variables: Record<string, unknown>,
  visitCounts: Record<string, number>,
): Record<string, unknown> {
  // Default: empty object for nodes without mockInputs
  // Issue #369: nodes without inputSchema only accept null or {}
  if (mockInput === undefined) {
    return {};
  }

  const visitCount = visitCounts[nodeId] || 0;

  // Function: call with context
  if (typeof mockInput === "function") {
    return mockInput({ variables, visitCount, nodeId });
  }

  // Array: return element by visit count (cycle through array)
  if (Array.isArray(mockInput)) {
    if (mockInput.length === 0) {
      return {};
    }
    // Cycle through array if we've visited more times than array length
    const index = visitCount % mockInput.length;
    return mockInput[index];
  }

  // Object: return as-is (even if empty)
  return mockInput;
}

/**
 * Check expectations against actual results
 */
function checkExpectations(
  expect: ScenarioExpectations,
  visitedNodes: string[],
  finalContext: Record<string, unknown>,
  status: string,
): string[] {
  const failures: string[] = [];

  // Check reaches
  if (expect.reaches) {
    for (const nodeId of expect.reaches) {
      if (!visitedNodes.includes(nodeId)) {
        failures.push(`Expected to reach node '${nodeId}' but it was not visited`);
      }
    }
  }

  // Check avoids
  if (expect.avoids) {
    for (const nodeId of expect.avoids) {
      if (visitedNodes.includes(nodeId)) {
        failures.push(`Expected to avoid node '${nodeId}' but it was visited`);
      }
    }
  }

  // Check status
  if (expect.status) {
    if (status !== expect.status) {
      failures.push(`Expected status '${expect.status}' but got '${status}'`);
    }
  }

  // Check context contains
  if (expect.contextContains) {
    for (const [key, expectedValue] of Object.entries(expect.contextContains)) {
      const actualValue = finalContext[key];
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        failures.push(
          `Expected context['${key}'] to be ${JSON.stringify(expectedValue)} but got ${JSON.stringify(actualValue)}`,
        );
      }
    }
  }

  return failures;
}

/**
 * Check for input validation errors in the message queue.
 * If validation failed, throw immediately instead of continuing to loop.
 *
 * @throws Error with validation details and provided mockInput
 */
function checkForValidationError(
  messageQueue: AgentMessageQueue,
  nodeId: string,
  mockInput: Record<string, unknown>,
): void {
  const messages = (messageQueue as unknown as { messages: unknown[] }).messages;

  if (!messages || messages.length === 0) {
    return;
  }

  for (const message of messages) {
    if ((message as { type: unknown }).type !== AgentMessageType.DIRECTIVE) {
      continue;
    }

    const directiveMessage = message as DirectiveMessage;
    const { directive } = directiveMessage;

    // Check for validation error markers
    const hasValidationError =
      directive.includes("EXPECTED INPUT FORMAT:") || directive.includes("VALIDATION ERROR");

    if (hasValidationError) {
      // Extract the expected format section for cleaner error
      const formatMatch = directive.match(
        /EXPECTED INPUT FORMAT:\n([\s\S]*?)(?:\n\nYOUR INPUT:|$)/,
      );
      const expectedFormat = formatMatch ? formatMatch[1].trim() : "See full error below";

      const errorLines: string[] = [
        `Input validation failed for node '${nodeId}'`,
        "",
        "PROVIDED MOCK INPUT:",
        JSON.stringify(mockInput, null, 2),
        "",
        "EXPECTED FORMAT:",
        expectedFormat,
        "",
        `FIX: Update mockInputs['${nodeId}'] in your test scenario to match the schema.`,
      ];

      throw new Error(errorLines.join("\n"));
    }
  }
}

/**
 * Generate diagnostics for scenarios that hit max steps (likely loops)
 */
function generateLoopDiagnostics(
  visitedNodes: string[],
  visitCounts: Record<string, number>,
  mockInputNodeIds: string[],
): LoopDiagnostics {
  // Last 20 nodes visited
  const lastNodes = visitedNodes.slice(-20);

  // Nodes visited more than once
  const repeatedNodes = Object.entries(visitCounts)
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([nodeId]) => nodeId);

  // Nodes in mockInputs that were never visited
  const visitedSet = new Set(visitedNodes);
  const unusedMockInputs = mockInputNodeIds.filter((nodeId) => !visitedSet.has(nodeId));

  // Nodes visited that have no mockInput defined
  const mockInputSet = new Set(mockInputNodeIds);
  const missingMockInputs = [...new Set(visitedNodes)].filter(
    (nodeId) => !mockInputSet.has(nodeId),
  );

  // Try to detect loop pattern in last nodes
  const detectedLoop = detectLoopPattern(lastNodes);

  return {
    lastNodes,
    visitCounts,
    repeatedNodes,
    unusedMockInputs,
    missingMockInputs,
    detectedLoop,
  };
}

/**
 * Detect repeating pattern in node sequence
 * Returns pattern like "A → B → C → A" if found
 */
function detectLoopPattern(nodes: string[]): string | undefined {
  if (nodes.length < 4) return undefined;

  // Try to find repeating patterns of length 2-10
  for (let patternLen = 2; patternLen <= Math.min(10, Math.floor(nodes.length / 2)); patternLen++) {
    const pattern = nodes.slice(-patternLen);
    const prevPattern = nodes.slice(-patternLen * 2, -patternLen);

    if (pattern.length === prevPattern.length && pattern.every((n, i) => n === prevPattern[i])) {
      return pattern.join(" → ");
    }
  }

  return undefined;
}

/**
 * Format loop diagnostics into readable error message
 */
function formatLoopError(diag: LoopDiagnostics, maxSteps: number): string {
  const lines: string[] = [];

  lines.push(`Scenario hit max steps limit (${maxSteps}) - likely infinite loop`);
  lines.push("");

  if (diag.detectedLoop) {
    lines.push(`🔄 DETECTED LOOP PATTERN: ${diag.detectedLoop}`);
    lines.push("");
  }

  lines.push(`📍 Last 10 nodes visited:`);
  lines.push(`   ${diag.lastNodes.slice(-10).join(" → ")}`);
  lines.push("");

  if (diag.repeatedNodes.length > 0) {
    lines.push(`🔁 Most repeated nodes (potential loop):`);
    const topRepeated = diag.repeatedNodes.slice(0, 5);
    for (const nodeId of topRepeated) {
      lines.push(`   - ${nodeId}: ${diag.visitCounts[nodeId]} visits`);
    }
    lines.push("");
  }

  if (diag.missingMockInputs.length > 0) {
    lines.push(`⚠️  Nodes visited WITHOUT mockInput defined:`);
    const uniqueMissing = [...new Set(diag.missingMockInputs)].slice(0, 10);
    for (const nodeId of uniqueMissing) {
      lines.push(`   - ${nodeId}`);
    }
    if (diag.missingMockInputs.length > 10) {
      lines.push(`   ... and ${diag.missingMockInputs.length - 10} more`);
    }
    lines.push("");
  }

  if (diag.unusedMockInputs.length > 0) {
    lines.push(`❓ MockInputs defined but nodes never reached:`);
    for (const nodeId of diag.unusedMockInputs.slice(0, 10)) {
      lines.push(`   - ${nodeId}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Validate rendered directives for unrendered template patterns.
 *
 * Called after each executeGraph() step to catch template errors early.
 * Checks all directive messages in the queue for:
 *
 * 1. **Unrendered templates** (`{{...}}`):
 *    - `{{variable}}` - variable not substituted
 *    - `{{#if condition}}` - unclosed conditional block
 *    - `{{/if}}` - orphaned closing tag
 *    - `{{else}}` - orphaned else
 *
 * 2. **Null values**:
 *    - Literal "null" string indicates GraphTemplateProcessor couldn't find variable
 *    - Pattern matches standalone "null" not part of words like "nullable"
 *
 * Skips system validation messages (contain "EXPECTED INPUT FORMAT:").
 *
 * @throws Error with node ID and problematic content excerpt
 */
function validateRenderedDirectives(messageQueue: AgentMessageQueue, nodeId: string): void {
  // Access messages through flush (returns and clears)
  // We need to get messages without clearing, so we'll check the queue state
  const messages = (messageQueue as unknown as { messages: unknown[] }).messages;

  if (!messages || messages.length === 0) {
    return;
  }

  for (const message of messages) {
    // Only check directive messages
    if ((message as { type: unknown }).type !== AgentMessageType.DIRECTIVE) {
      continue;
    }

    const directiveMessage = message as DirectiveMessage;
    const { directive, completionCondition } = directiveMessage;

    // Skip system/validation error messages (contain schema validation output)
    if (directive.includes("EXPECTED INPUT FORMAT:") || directive.includes("Validation failed:")) {
      continue;
    }

    // Check directive field
    validateTemplateField(directive, directiveMessage.nodeId, "directive");

    // Check completionCondition field
    validateTemplateField(completionCondition, directiveMessage.nodeId, "completionCondition");
  }
}

/**
 * Validate a single template field for unrendered patterns.
 *
 * @param content - Rendered directive or completionCondition text
 * @param nodeId - Node ID for error reporting
 * @param fieldName - Field name ("directive" or "completionCondition")
 * @throws Error if unrendered templates or null values found
 */
function validateTemplateField(content: string, nodeId: string, fieldName: string): void {
  if (!content) return;

  // Pattern 1: Unrendered template variables {{...}}
  // Matches: {{variable}}, {{#if condition}}, {{/if}}, {{else}}, etc.
  // Excludes Go/Docker format strings like {{.Names}}, {{.Status}} (start with dot)
  const unrenderedPattern = /\{\{(?!\.[A-Z])[^}]+\}\}/g;
  const unrenderedMatches = content.match(unrenderedPattern);

  if (unrenderedMatches) {
    throw new Error(
      `Unrendered template in node '${nodeId}' ${fieldName}: ${unrenderedMatches.slice(0, 3).join(", ")}` +
        (unrenderedMatches.length > 3 ? ` ... and ${unrenderedMatches.length - 3} more` : ""),
    );
  }

  // Pattern 2: Check for UNDEFINED_PLACEHOLDER from GraphTemplateProcessor
  // This is the reliable indicator of undefined/null variable
  const placeholder = GraphTemplateProcessor.UNDEFINED_PLACEHOLDER;
  if (content.includes(placeholder)) {
    // Extract context around placeholder for better error message
    const placeholderIndex = content.indexOf(placeholder);
    const contextStart = Math.max(0, placeholderIndex - 20);
    const contextEnd = Math.min(content.length, placeholderIndex + placeholder.length + 20);
    const context = content.substring(contextStart, contextEnd);

    throw new Error(`Undefined variable in node '${nodeId}' ${fieldName}: "...${context}..."`);
  }
}
