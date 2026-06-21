/**
 * Test Constants
 * Centralized constants for E2E tests
 */

import { getAdminCredentials } from "../../utils/test-config.js";

const adminCreds = getAdminCredentials();

export const TEST_USERS = {
  ADMIN: {
    email: adminCreds.email,
    password: adminCreds.password,
    id: "system-admin",
  },
  MCP_TOOLS_TEST: {
    email: "mcp-tools-test@example.com",
    password: "ToolsPass123!",
    name: "MCP Tools Test",
  },
  VISIBILITY_TEST: {
    email: "visibility-test@example.com",
    password: "VisTest123!",
    name: "Visibility Test",
  },
} as const;

export const TEST_WORKFLOWS = {
  REACT_FLOW_THEME: {
    id: "react-flow-theme-test",
    name: "React Flow Theme Test",
    filename: "react-flow-theme-test.json",
    visibility: "private" as const,
  },
  PUBLIC_TEST: {
    id: "public-test-workflow",
    name: "Public Test Workflow",
    filename: "public-test-workflow.json",
    visibility: "public" as const,
  },
  MCP_TOOLS_PRIVATE: {
    id: "mcp-tools-private-workflow",
    name: "MCP Tools Private Workflow",
    filename: "mcp-tools-private-workflow.json",
    visibility: "private" as const,
  },
} as const;
