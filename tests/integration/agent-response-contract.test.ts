/**
 * Agent Response Contract Integration Tests (Step 11)
 *
 * The agent-facing contract for a node that writes both workflow-global values and node-local
 * outputs: the agent receives ONE ordinary flat JSON Schema (globalInputs already inlined from the
 * registry, the globalInputs key removed — the agent never sees the global/local split), submits ONE
 * flat object, the submission is validated against that schema, and the result is routed by the
 * node's declaration into the global (bare-name) and node-local (node-id.name) scopes. Keys not in
 * the schema are rejected with a clear message.
 */

import { describe, test, expect } from "@jest/globals";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";

function combinedScopeWorkflow(): WorkflowGraph {
  return {
    id: "agent-contract-combined",
    metadata: {
      name: "Agent Contract",
      version: "1.0.0",
      description: "Combined global+local output",
    },
    variableRegistry: {
      score: { type: "number", description: "Overall score (global)" },
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "produce" } },
      {
        type: "agent-directive",
        id: "produce",
        directive: "Produce a score and a note",
        completionCondition: "Done",
        inputSchema: {
          type: "object",
          // `score` is a global write (registry); `note` is a node-local output.
          globalInputs: ["score"],
          properties: { note: { type: "string", description: "A local note" } },
          required: ["score", "note"],
        },
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

describe("Agent Response Contract (combined global + local output)", () => {
  test("agent receives one flat schema with globals inlined and no globalInputs key", async () => {
    const { repository, executor } = await createTestExecutor();
    const workflow = combinedScopeWorkflow();
    await repository.saveWorkflow(workflow, TEST_USER_ID);
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);

    const directive = await executor.executeStep(executionId);

    // The agent sees an ordinary JSON Schema rendered in the directive.
    expect(directive).toContain("Input Schema:");
    // The global `score` is inlined as a normal property with its registry type/description.
    expect(directive).toContain('"score"');
    expect(directive).toContain('"Overall score (global)"');
    expect(directive).toContain('"note"');
    // The non-standard scope key is NOT exposed to the agent.
    expect(directive).not.toContain("globalInputs");
  });

  test("one combined flat object is validated and routed to global and node-local scopes", async () => {
    const { repository, executor } = await createTestExecutor();
    const workflow = combinedScopeWorkflow();
    await repository.saveWorkflow(workflow, TEST_USER_ID);
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);
    await executor.executeStep(executionId);

    // Agent submits ONE flat object combining the global and the local value.
    const result = await executor.executeStep(executionId, { score: 92, note: "looks good" });
    expect(result).toContain("Workflow completed successfully");

    const state = await executor.getExecutionState(executionId);
    const vars = state!.globalContext.variables;
    // Declared global → top-level bare-name scope.
    expect(vars.score).toBe(92);
    // Local output → NOT promoted to the top level.
    expect(vars.note).toBeUndefined();
    // Both present in the node-local scope (node-id.name).
    const produceScope = vars.produce as Record<string, unknown>;
    expect(produceScope.score).toBe(92);
    expect(produceScope.note).toBe("looks good");
  });

  test("a submission with an undeclared key is rejected with a clear message", async () => {
    const { repository, executor } = await createTestExecutor();
    const workflow = combinedScopeWorkflow();
    await repository.saveWorkflow(workflow, TEST_USER_ID);
    const executionId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);
    await executor.executeStep(executionId);

    // `surprise` is neither a global write nor a described local output.
    const result = await executor.executeStep(executionId, {
      score: 50,
      note: "ok",
      surprise: "unexpected",
    });

    // Rejected with an actionable validation message; nothing was written.
    expect(result.toLowerCase()).toMatch(/validation|not allowed|additional|schema|undeclared/);

    const state = await executor.getExecutionState(executionId);
    const vars = state!.globalContext.variables;
    expect(vars.score).toBeUndefined();
    expect(vars.surprise).toBeUndefined();
  });
});
