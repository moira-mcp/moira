/** @type {import('jest').Config} */
import baseConfig from "./jest.base.config.js";

export default {
  ...baseConfig,
  displayName: "API Tests",
  testMatch: ["<rootDir>/tests/api/**/*.test.ts"],
  testTimeout: 90000,
  maxWorkers: 5, // WAL mode allows concurrent access; admin-logout-all removed to enable parallelism
  workerIdleMemoryLimit: "4GB",
  setupFiles: ["<rootDir>/tests/config/jest-memory-setup.js"],
  // API tests only need HTTP client - no shared module imports
  // Override setupFilesAfterEnv to skip test-helpers that import @mcp-moira/*
  setupFilesAfterEnv: [],
};
