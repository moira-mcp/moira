/** @type {import('jest').Config} */
import baseConfig from "./jest.base.config.js";

const testPathIgnorePatterns =
  process.env.API_TEST_TARGET === "saas"
    ? ["self-host-auth\\.test\\.ts$", "capability-boundary-api\\.test\\.ts$"]
    : [];

export default {
  ...baseConfig,
  displayName: "API Tests",
  testMatch: ["<rootDir>/tests/api/**/*.test.ts"],
  testPathIgnorePatterns,
  testTimeout: 90000,
  maxWorkers: 5, // WAL mode allows concurrent access; admin-logout-all removed to enable parallelism
  workerIdleMemoryLimit: "4GB",
  setupFiles: ["<rootDir>/tests/config/jest-memory-setup.js"],
  // API tests need browser-equivalent Origin headers for direct Better Auth requests.
  setupFilesAfterEnv: ["<rootDir>/tests/setup-origin-fetch.ts"],
};
