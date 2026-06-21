/** @type {import('jest').Config} */
module.exports = {
  // Set rootDir to project root (two levels up from tests/config/)
  rootDir: "../../",

  // Jest projects configuration for test type separation
  projects: [
    "<rootDir>/tests/config/jest.unit.config.js",
    "<rootDir>/tests/config/jest.integration.config.js",
    "<rootDir>/tests/config/jest.integration-api.config.js",
    "<rootDir>/tests/config/jest.e2e.config.js",
  ],

  // Global coverage settings
  collectCoverage: false, // Disabled by default, enable per project
  coverageDirectory: "<rootDir>/coverage",

  // Global memory optimization
  maxWorkers: 1, // Conservative for memory issues
  workerIdleMemoryLimit: "4GB", // Increased heap size per plan requirements

  // Global setup
  setupFiles: ["<rootDir>/tests/config/jest-memory-setup.js"],

  // Prevent Jest from running tests directly - only through projects
  testMatch: [],
};
