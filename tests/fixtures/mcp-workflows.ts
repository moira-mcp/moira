/**
 * MCP Test Workflow Fixtures
 * Centralized workflow definitions for MCP E2E tests
 */

export const MCP_TEST_WORKFLOWS = {
  SIMPLE_LINEAR: {
    id: "mcp-test-simple-linear",
    name: "MCP Test: Simple Linear Workflow",
    description: "Simple 2-step linear workflow for basic execution tests",
    workflow: {
      id: "mcp-test-simple-linear",
      metadata: {
        name: "MCP Test: Simple Linear Workflow",
        version: "1.0.0",
        description: "Simple 2-step linear workflow for basic execution tests",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "step1" },
          initialData: {
            variables: {
              testValue: { description: "Initial test value", value: "initial" },
            },
          },
        },
        {
          type: "agent-directive",
          id: "step1",
          directive: "Complete step 1 with provided input",
          completionCondition: "Step 1 completed",
          connections: { success: "step2" },
          inputSchema: {
            type: "object",
            properties: {
              step1_result: { type: "string" },
            },
            required: ["step1_result"],
          },
        },
        {
          type: "agent-directive",
          id: "step2",
          directive: "Complete step 2 with provided input",
          completionCondition: "Step 2 completed",
          connections: { success: "end" },
          inputSchema: {
            type: "object",
            properties: {
              step2_result: { type: "string" },
            },
            required: ["step2_result"],
          },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    },
  },

  WITH_CONDITION: {
    id: "mcp-test-with-condition",
    name: "MCP Test: Conditional Branching",
    description: "Workflow with condition node for testing branching logic",
    workflow: {
      id: "mcp-test-with-condition",
      metadata: {
        name: "MCP Test: Conditional Branching",
        version: "1.0.0",
        description: "Workflow with condition node for testing branching logic",
      },
      variableRegistry: {
        testValue: {
          type: "string",
          description: "Value set by the setup step, checked by the condition",
        },
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "setup" },
        },
        {
          type: "agent-directive",
          id: "setup",
          directive: "Set testValue variable for condition",
          completionCondition: "Variable set",
          connections: { success: "check" },
          inputSchema: {
            type: "object",
            globalInputs: ["testValue"],
            properties: {},
            required: ["testValue"],
          },
        },
        {
          type: "condition",
          id: "check",
          condition: {
            left: { contextPath: "testValue" },
            operator: "eq",
            right: "yes",
          },
          connections: {
            true: "path_true",
            false: "path_false",
          },
        },
        {
          type: "agent-directive",
          id: "path_true",
          directive: "True path execution",
          completionCondition: "True path completed",
          connections: { success: "end" },
          inputSchema: {
            type: "object",
            properties: {
              result: { type: "string" },
            },
            required: ["result"],
          },
        },
        {
          type: "agent-directive",
          id: "path_false",
          directive: "False path execution",
          completionCondition: "False path completed",
          connections: { success: "end" },
          inputSchema: {
            type: "object",
            properties: {
              result: { type: "string" },
            },
            required: ["result"],
          },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    },
  },

  CONTEXT_PRESERVATION: {
    id: "mcp-test-context-preservation",
    name: "MCP Test: Context Preservation",
    description: "Workflow for testing context variable preservation across steps",
    workflow: {
      id: "mcp-test-context-preservation",
      metadata: {
        name: "MCP Test: Context Preservation",
        version: "1.0.0",
        description: "Workflow for testing context variable preservation across steps",
      },
      variableRegistry: {
        sharedValue: {
          type: "string",
          description: "Shared value from start",
          default: "from_start",
        },
        counter: { type: "number", description: "Counter variable", default: 0 },
        newValue: { type: "string", description: "New value stored by step1" },
        incrementedCounter: { type: "number", description: "Incremented counter stored by step1" },
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "step1" },
        },
        {
          type: "agent-directive",
          id: "step1",
          directive: "Store new data in context",
          completionCondition: "Data stored",
          connections: { success: "end" },
          inputSchema: {
            type: "object",
            globalInputs: ["newValue", "incrementedCounter"],
            properties: {},
            required: ["newValue", "incrementedCounter"],
          },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    },
  },

  MULTI_STEP: {
    id: "mcp-test-multi-step",
    name: "MCP Test: Multi-Step Workflow",
    description: "Workflow with 5 steps for testing sequential execution",
    workflow: {
      id: "mcp-test-multi-step",
      metadata: {
        name: "MCP Test: Multi-Step Workflow",
        version: "1.0.0",
        description: "Workflow with 5 steps for testing sequential execution",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "step1" },
        },
        ...Array.from({ length: 5 }, (_, i) => ({
          type: "agent-directive",
          id: `step${i + 1}`,
          directive: `Complete step ${i + 1}`,
          completionCondition: `Step ${i + 1} completed`,
          connections: { success: i === 4 ? "end" : `step${i + 2}` },
          inputSchema: {
            type: "object",
            properties: {
              result: { type: "string" },
            },
            required: ["result"],
          },
        })),
        {
          type: "end",
          id: "end",
        },
      ],
    },
  },

  VALIDATION_TEST: {
    id: "mcp-test-validation",
    name: "MCP Test: Input Validation",
    description: "Workflow for testing input schema validation",
    workflow: {
      id: "mcp-test-validation",
      metadata: {
        name: "MCP Test: Input Validation",
        version: "1.0.0",
        description: "Workflow for testing input schema validation",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "strict_input" },
        },
        {
          type: "agent-directive",
          id: "strict_input",
          directive: "Provide data matching strict schema",
          completionCondition: "Schema validated",
          connections: { success: "end" },
          inputSchema: {
            type: "object",
            properties: {
              requiredString: { type: "string", minLength: 3 },
              requiredNumber: { type: "number", minimum: 0, maximum: 100 },
              optionalBoolean: { type: "boolean" },
            },
            required: ["requiredString", "requiredNumber"],
          },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    },
  },

  WITH_EXPRESSION: {
    id: "mcp-test-with-expression",
    name: "MCP Test: Expression Node",
    description: "Workflow with expression node for testing arithmetic operations",
    workflow: {
      id: "mcp-test-with-expression",
      metadata: {
        name: "MCP Test: Expression Node",
        version: "1.0.0",
        description: "Workflow with expression node for testing arithmetic operations",
      },
      variableRegistry: {
        counter: { type: "number", description: "Counter variable", default: 0 },
        multiplier: { type: "number", description: "Multiplier value", default: 3 },
        result: { type: "number", description: "Computed result (counter * multiplier)" },
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "calc" },
        },
        {
          type: "expression",
          id: "calc",
          expressions: ["counter = counter + 1", "result = counter * multiplier"],
          connections: { default: "verify" },
        },
        {
          type: "agent-directive",
          id: "verify",
          directive:
            "Expression node test completed. Counter is now {{counter}}, result is {{result}}. Report these values.",
          completionCondition: "Values reported",
          connections: { success: "end" },
          inputSchema: {
            type: "object",
            properties: {
              confirmation: { type: "string" },
            },
            required: ["confirmation"],
          },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    },
  },

  EXPRESSION_CHAIN: {
    id: "mcp-test-expression-chain",
    name: "MCP Test: Expression Chain",
    description: "Workflow with multiple expression nodes for testing chained calculations",
    workflow: {
      id: "mcp-test-expression-chain",
      metadata: {
        name: "MCP Test: Expression Chain",
        version: "1.0.0",
        description: "Workflow with multiple expression nodes for testing chained calculations",
      },
      variableRegistry: {
        step_index: { type: "number", description: "Step index counter", default: 0 },
        iteration: { type: "number", description: "Iteration counter", default: 0 },
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "init" },
        },
        {
          type: "expression",
          id: "init",
          expressions: ["step_index = 1", "iteration = 1"],
          connections: { default: "increment" },
        },
        {
          type: "expression",
          id: "increment",
          expressions: ["iteration = iteration + 1"],
          connections: { default: "advance" },
        },
        {
          type: "expression",
          id: "advance",
          expressions: ["step_index = step_index + 1", "iteration = 1"],
          connections: { default: "verify" },
        },
        {
          type: "agent-directive",
          id: "verify",
          directive:
            "Chain test completed. step_index={{step_index}}, iteration={{iteration}}. Report values.",
          completionCondition: "Values reported",
          connections: { success: "end" },
          inputSchema: {
            type: "object",
            properties: {
              confirmation: { type: "string" },
            },
            required: ["confirmation"],
          },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    },
  },

  EXPRESSION_WITH_NESTED_PATH: {
    id: "mcp-test-expression-nested",
    name: "MCP Test: Expression Nested Paths",
    description: "Workflow testing expression node with nested context paths",
    workflow: {
      id: "mcp-test-expression-nested",
      metadata: {
        name: "MCP Test: Expression Nested Paths",
        version: "1.0.0",
        description: "Workflow testing expression node with nested context paths",
      },
      variableRegistry: {
        plan: {
          type: "object",
          description: "Plan object with step counters",
          default: { current_step: 5, total_steps: 10 },
        },
        next_step: { type: "number", description: "Next step index (plan.current_step + 1)" },
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "calc" },
        },
        {
          type: "expression",
          id: "calc",
          expressions: ["next_step = plan.current_step + 1"],
          connections: { default: "verify" },
        },
        {
          type: "agent-directive",
          id: "verify",
          directive: "Nested path test completed. next_step={{next_step}}. Report value.",
          completionCondition: "Value reported",
          connections: { success: "end" },
          inputSchema: {
            type: "object",
            properties: {
              confirmation: { type: "string" },
            },
            required: ["confirmation"],
          },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    },
  },
} as const;

export type MCPTestWorkflowKey = keyof typeof MCP_TEST_WORKFLOWS;
