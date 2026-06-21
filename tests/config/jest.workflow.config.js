/** @type {import('jest').Config} */
import baseConfig from "./jest.base.config.js";

export default {
  ...baseConfig,
  displayName: "Workflow Tests",
  testMatch: ["<rootDir>/tests/workflow/**/*.test.ts"],
  testTimeout: 30000,
  maxWorkers: process.env.CI ? "50%" : 6,
  workerIdleMemoryLimit: "512MB",
};
