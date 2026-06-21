/** @type {import('jest').Config} */
import baseConfig from "./jest.base.config.js";

export default {
  ...baseConfig,
  displayName: "Unit Tests",
  testMatch: ["<rootDir>/tests/unit/**/*.test.ts", "<rootDir>/tests/unit/**/*.test.tsx"],
  testTimeout: 30000,
  // Use 50% of CPUs in CI (2 cores = 1 worker), more locally
  maxWorkers: process.env.CI ? "50%" : 6,
  workerIdleMemoryLimit: "512MB",
  // For jsdom tests - polyfills loaded BEFORE environment setup
  setupFiles: ["<rootDir>/tests/setup-jsdom.ts"],
  // Additional module mappings for frontend components
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    // Frontend path aliases
    "^@/(.*)$": "<rootDir>/packages/web-frontend/src/$1",
  },
};
