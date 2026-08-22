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
  // Every integration file shares one migrated SQLite database. Run files in
  // one worker so write transactions are isolated by test order instead of
  // racing until busy_timeout expires; WAL still benefits reads within a file.
  maxWorkers: 1,
  workerIdleMemoryLimit: "4GB",
  globalSetup: "<rootDir>/tests/config/jest-integration-global-setup.js",
  setupFiles: [
    "<rootDir>/tests/config/jest-memory-setup.js",
    "<rootDir>/tests/config/jest-integration-setup.js",
  ],
};
