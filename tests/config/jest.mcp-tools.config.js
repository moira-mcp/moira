/**
 * Jest configuration for MCP Tools E2E tests
 * Tests MCP protocol directly via @modelcontextprotocol/sdk
 */

export default {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: {
            syntax: "typescript",
            decorators: true,
          },
          target: "es2022",
        },
        module: {
          type: "es6",
        },
      },
    ],
  },
  rootDir: "../..",
  testMatch: ["<rootDir>/tests/mcp-tools/**/*.test.ts"],
  setupFilesAfterEnv: [],
  testTimeout: 30000,
  verbose: true,
  bail: false,
  maxWorkers: 2,
};
