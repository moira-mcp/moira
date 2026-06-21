/** @type {import('jest').Config} */
import baseConfig from "./jest.base.config.js";

export default {
  ...baseConfig,
  displayName: "E2E Tests",
  testMatch: ["<rootDir>/tests/e2e/**/*.test.ts"],
  testTimeout: 180000,
  maxWorkers: 1,
  workerIdleMemoryLimit: "4GB",
  setupFiles: ["<rootDir>/tests/config/jest-memory-setup.js"],
  // E2E tests only need HTTP/MCP client - no shared module imports
  setupFilesAfterEnv: [],
};
