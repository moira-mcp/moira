/**
 * MCP Test Data
 * Centralized test data for MCP E2E tests
 */

export const MCP_TEST_DATA = {
  // Execution test inputs
  EXECUTION_INPUTS: {
    STEP1_SIMPLE: {
      step1_result: "Step 1 completed successfully",
    },
    STEP2_SIMPLE: {
      step2_result: "Step 2 completed successfully",
    },
    CONDITION_TRUE: {
      testValue: "yes",
    },
    CONDITION_FALSE: {
      testValue: "no",
    },
    CONTEXT_DATA: {
      newValue: "from_step1",
      incrementedCounter: 1,
    },
    VALID_INPUT: {
      requiredString: "valid",
      requiredNumber: 50,
      optionalBoolean: true,
    },
    INVALID_MISSING_REQUIRED: {
      wrong_field: "invalid",
    },
    INVALID_TYPE: {
      requiredString: 123, // Should be string
      requiredNumber: "not a number",
    },
  },

  // Expected values for assertions
  EXPECTED_VALUES: {
    INITIAL_NODE: "step1",
    END_NODE: "end",
    TRUE_PATH_NODE: "path_true",
    FALSE_PATH_NODE: "path_false",
    INITIAL_CONTEXT_VALUE: "initial",
    SHARED_VALUE_FROM_START: "from_start",
  },

  // Token test data
  TOKEN_DATA: {
    TTL_SHORT: 5, // 5 minutes
    TTL_MEDIUM: 60, // 1 hour
    TTL_LONG: 1440, // 24 hours
    TEST_UPLOAD_WORKFLOW: {
      id: "test-upload-workflow",
      metadata: {
        name: "Test Upload Workflow",
        version: "1.0.0",
        description: "Test workflow for upload",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    },
  },

  // Settings test data
  SETTINGS_DATA: {
    UI_THEME_DARK: {
      key: "ui.theme",
      value: "dark",
    },
    UI_THEME_LIGHT: {
      key: "ui.theme",
      value: "light",
    },
    TELEGRAM_BOT_TOKEN: {
      key: "telegram.bot_token",
      value: "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz",
    },
    TELEGRAM_CHAT_ID: {
      key: "telegram.chat_id",
      value: "123456789",
    },
    PROFILE_DISPLAY_NAME: {
      key: "profile.display_name",
      value: "Test User Display Name",
    },
  },

  // Workflow CRUD test data
  CRUD_WORKFLOWS: {
    SIMPLE_CREATE: {
      id: "test-crud-create",
      metadata: {
        name: "Test CRUD Create",
        version: "1.0.0",
        description: "Test workflow for create operation",
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "end" } },
        { type: "end", id: "end" },
      ],
    },
    UPDATED_VERSION: {
      metadata: {
        name: "Updated Test CRUD",
        version: "2.0.0",
        description: "Updated description",
      },
    },
    NEW_NODE: {
      type: "agent-directive",
      id: "new-task",
      directive: "New task directive",
      completionCondition: "Task completed",
      connections: { success: "end" },
      inputSchema: {
        type: "object",
        properties: {
          result: { type: "string" },
        },
        required: ["result"],
      },
    },
    INVALID_EMPTY_NODES: {
      id: "invalid-empty",
      metadata: {
        name: "Invalid Workflow",
        version: "1.0.0",
        description: "Invalid: empty nodes",
      },
      nodes: [],
    },
    INVALID_NO_START: {
      id: "invalid-no-start",
      metadata: {
        name: "Invalid Workflow",
        version: "1.0.0",
        description: "Invalid: no start node",
      },
      nodes: [{ type: "end", id: "end" }],
    },
  },

  // Pagination test data
  PAGINATION: {
    OFFSET_0: 0,
    OFFSET_2: 2,
    OFFSET_5: 5,
    LIMIT_2: 2,
    LIMIT_5: 5,
    LIMIT_10: 10,
  },

  // Documentation test data
  DOCUMENTATION: {
    TOPICS: [
      "complete",
      "overview",
      "nodes",
      "workflow",
      "validation",
      "examples",
      "mcp",
      "templates",
    ],
    FORMATS: ["markdown", "json"],
    REQUIRED_SECTIONS: ["Moira Workflow Engine", "Overview", "Node Types", "Workflow Structure"],
    NODE_TYPES: ["start", "end", "agent-directive", "condition", "telegram-notification"],
    CORE_CONCEPTS: [
      "workflow",
      "node",
      "connection",
      "execution",
      "directive",
      "condition",
      "start",
      "end",
    ],
  },
} as const;

export type MCPTestDataKey = keyof typeof MCP_TEST_DATA;
