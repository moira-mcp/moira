/** @type {import('jest').Config} */
import baseConfig from "./jest.base.config.js";

export default {
  ...baseConfig,
  displayName: "Integration Tests",
  testMatch: [
    "<rootDir>/tests/integration/**/*.test.ts",
    "<rootDir>/tests/functional/**/*.test.ts",
  ],
  testTimeout: 90000,
  maxWorkers: 5, // WAL mode allows concurrent reads + serialized writes with busy_timeout
  workerIdleMemoryLimit: "4GB",
  globalSetup: "<rootDir>/tests/config/jest-integration-global-setup.js",
  setupFiles: [
    "<rootDir>/tests/config/jest-memory-setup.js",
    "<rootDir>/tests/config/jest-integration-setup.js",
  ],
};
