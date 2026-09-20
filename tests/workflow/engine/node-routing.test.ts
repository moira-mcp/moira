/**
 * N-output routing: a condition node routes to the first holding case or its default, an
 * agent-directive node routes on its own validated answer, and expressions on either node run
 * before routing and publish declared globals — or take the node's `error` output when they fail.
 */

import { describe, test, expect } from "@jest/globals";
import {
  AgentDirectiveHandler,
  ConditionHandler,
  AgentMessageQueue,
  ConditionBuilder,
  GraphValidator,
  inlineGlobalInputs,
} from "@mcp-moira/workflow-engine";
import type {
  AgentDirectiveNode,
  ConditionNode,
  IDataRepository,
  IGraphExecutionEngine,
  VariableRegistry,
  WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { TestUtils } from "../../utils/test-helpers.js";
import { runScenario, type TestScenario } from "../../helpers/scenario-runner.js";

const storage = {} as IDataRepository;
const engine = {} as IGraphExecutionEngine;

const outcomeIs = (value: string) =>
  ConditionBuilder.equals(ConditionBuilder.contextPath("review_outcome"), value);

describe("ConditionHandler with cases", () => {
  const node: ConditionNode = {
    type: "condition",
    id: "route",
    cases: [
      { when: outcomeIs("pass"), output: "continue" },
      { when: outcomeIs("repair"), output: "repair" },
      { when: outcomeIs("replan"), output: "replan" },
    ],
    connections: { continue: "advance", repair: "fix", replan: "revise", default: "unexpected" },
  };

  test.each([
    ["pass", "continue", 0],
    ["repair", "repair", 1],
    ["replan", "replan", 2],
  ])("answer %s takes output %s (case %i)", async (answer, output, index) => {
    const result = await new ConditionHandler().execute(
      node,
      TestUtils.createTestContext({ review_outcome: answer }),
      new AgentMessageQueue(),
      storage,
      engine,
    );
    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe(output);
    expect(result.data).toMatchObject({ output, matchedCase: index });
  });

  test("no holding case takes the default output", async () => {
    const result = await new ConditionHandler().execute(
      node,
      TestUtils.createTestContext({ review_outcome: "shrug" }),
      new AgentMessageQueue(),
      storage,
      engine,
    );
    expect(result.outputPath).toBe("default");
    expect(result.data).toMatchObject({ matchedCase: -1 });
  });

  test("expressions run before the cases and their assignments are published as globals", async () => {
    const registry: VariableRegistry = {
      attempt: { type: "number", description: "attempt counter" },
    };
    const counting: ConditionNode = {
      type: "condition",
      id: "count",
      expressions: ["attempt = attempt + 1"],
      cases: [
        {
          when: ConditionBuilder.greaterThanOrEqual(ConditionBuilder.contextPath("attempt"), 3),
          output: "escalate",
        },
      ],
      connections: { escalate: "escalate", default: "retry" },
    };
    const handler = new ConditionHandler();
    const second = await handler.execute(
      counting,
      TestUtils.createTestContext({ attempt: 1 }),
      new AgentMessageQueue(),
      storage,
      engine,
      undefined,
      registry,
    );
    expect(second.outputPath).toBe("default");
    expect(second.assignments).toEqual({ attempt: 2 });

    const third = await handler.execute(
      counting,
      TestUtils.createTestContext({ attempt: 2 }),
      new AgentMessageQueue(),
      storage,
      engine,
      undefined,
      registry,
    );
    expect(third.outputPath).toBe("escalate");
    expect(third.assignments).toEqual({ attempt: 3 });
  });

  test("a failing expression takes the error output and publishes nothing", async () => {
    const failing: ConditionNode = {
      type: "condition",
      id: "bad",
      expressions: ["ratio = total / divisor"],
      cases: [{ when: ConditionBuilder.exists("ratio"), output: "ok" }],
      connections: { ok: "next", default: "next", error: "handle" },
    };
    const result = await new ConditionHandler().execute(
      failing,
      TestUtils.createTestContext({ total: 1, divisor: 0 }),
      new AgentMessageQueue(),
      storage,
      engine,
    );
    expect(result.outputPath).toBe("error");
    expect(result.assignments).toBeUndefined();
  });

  test("a failing expression without an error output fails the node", async () => {
    const failing: ConditionNode = {
      type: "condition",
      id: "bad",
      expressions: ["ratio = total / divisor"],
      cases: [{ when: ConditionBuilder.exists("ratio"), output: "ok" }],
      connections: { ok: "next", default: "next" },
    };
    await expect(
      new ConditionHandler().execute(
        failing,
        TestUtils.createTestContext({ total: 1, divisor: 0 }),
        new AgentMessageQueue(),
        storage,
        engine,
      ),
    ).rejects.toThrow(/Expression evaluation failed at index 0/);
  });
});

describe("AgentDirectiveHandler routing on its own answer", () => {
  const node: AgentDirectiveNode = {
    type: "agent-directive",
    id: "review-plan",
    directive: "Review the plan",
    completionCondition: "Reviewed",
    inputSchema: {
      type: "object",
      properties: { review_outcome: { type: "string", enum: ["pass", "repair", "replan"] } },
      required: ["review_outcome"],
    },
    cases: [
      { when: outcomeIs("repair"), output: "repair" },
      {
        when: ConditionBuilder.equals(
          ConditionBuilder.contextPath("review-plan.review_outcome"),
          "replan",
        ),
        output: "replan",
      },
    ],
    connections: { success: "advance", repair: "repair-plan", replan: "revise-plan" },
  };

  test.each([
    ["repair", "repair"],
    ["replan", "replan"],
    ["pass", "success"],
  ])("answer %s takes output %s", async (answer, output) => {
    const result = await new AgentDirectiveHandler().execute(
      node,
      TestUtils.createTestContext(),
      new AgentMessageQueue(),
      storage,
      engine,
      { review_outcome: answer },
    );
    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe(output);
    expect(result.data).toEqual({ review_outcome: answer });
  });

  test("an invalid answer is still rejected before any routing", async () => {
    await expect(
      new AgentDirectiveHandler().execute(
        node,
        TestUtils.createTestContext(),
        new AgentMessageQueue(),
        storage,
        engine,
        { review_outcome: "maybe" },
      ),
    ).rejects.toThrow(/Input validation failed/);
  });

  test("expressions on a directive see the answer and publish declared globals", async () => {
    const registry: VariableRegistry = {
      findings_total: { type: "number", description: "running total" },
      issues_count: { type: "number", description: "issues in this round" },
    };
    const summing: AgentDirectiveNode = {
      type: "agent-directive",
      id: "review",
      directive: "Review",
      completionCondition: "Reviewed",
      inputSchema: {
        type: "object",
        properties: {},
        globalInputs: ["issues_count"],
        required: ["issues_count"],
      },
      expressions: ["findings_total = findings_total + issues_count"],
      cases: [
        {
          when: ConditionBuilder.greaterThan(ConditionBuilder.contextPath("issues_count"), 0),
          output: "repair",
        },
      ],
      connections: { success: "done", repair: "fix" },
    };
    // The engine inlines declared globals into the schema the agent is validated against
    // before it calls the handler; mirror that here.
    const result = await new AgentDirectiveHandler().execute(
      inlineGlobalInputs(summing, registry),
      TestUtils.createTestContext({ findings_total: 4 }),
      new AgentMessageQueue(),
      storage,
      engine,
      { issues_count: 2 },
      registry,
    );
    expect(result.outputPath).toBe("repair");
    expect(result.assignments).toEqual({ findings_total: 6 });
  });
});

describe("routing in a whole run", () => {
  const workflow: WorkflowGraph = {
    id: "routing-scenario",
    metadata: {
      name: "Routing",
      version: "1.0.0",
      description: "three-way routing",
      schemaVersion: 1,
    },
    variableRegistry: {
      verdict: { type: "string", description: "review verdict" },
      rounds: { type: "number", description: "review rounds", default: 0 },
    },
    nodes: [
      { type: "start", id: "start", connections: { default: "review" } },
      {
        type: "agent-directive",
        id: "review",
        directive: "Give a verdict",
        completionCondition: "Verdict given",
        inputSchema: {
          type: "object",
          properties: {},
          globalInputs: ["verdict"],
          required: ["verdict"],
        },
        expressions: ["rounds = rounds + 1"],
        cases: [
          {
            when: ConditionBuilder.equals(ConditionBuilder.contextPath("verdict"), "repair"),
            output: "repair",
          },
          {
            when: ConditionBuilder.equals(ConditionBuilder.contextPath("verdict"), "replan"),
            output: "replan",
          },
        ],
        connections: { success: "done", repair: "fix", replan: "revise" },
      },
      { type: "end", id: "done" },
      { type: "end", id: "fix" },
      { type: "end", id: "revise" },
    ],
  };

  test.each([
    ["pass", "done"],
    ["repair", "fix"],
    ["replan", "revise"],
  ])("verdict %s ends at %s with the expression's global committed", async (verdict, end) => {
    const scenario: TestScenario = {
      name: `verdict-${verdict}`,
      mockInputs: { review: { verdict } },
      expect: {
        reaches: ["start", "review", end],
        status: "completed",
        contextContains: { rounds: 1 },
      },
    };
    const result = await runScenario(workflow, scenario);
    expect(result.failedExpectations ?? []).toEqual([]);
    expect(result.passed).toBe(true);
  });

  test("the definition validates: every authored output is covered by a case", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });
});
