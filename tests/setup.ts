/**
 * Jest Setup - Global Test Helpers Registration
 * Registers test utilities as global functions (no imports needed)
 *
 * NOTE: .env.local is loaded by test runner scripts before Jest starts
 */

import {
  createTestRepository,
  createTestExecutor,
  createTestMCPEngine,
  TEST_USER_ID,
  TEST_WORKFLOWS_PATH,
  TestUtils,
} from "./utils/test-helpers.js";

// Register helpers globally for use in tests without imports
(global as any).createTestRepository = createTestRepository;
(global as any).createTestExecutor = createTestExecutor;
(global as any).createTestMCPEngine = createTestMCPEngine;
(global as any).TEST_USER_ID = TEST_USER_ID;
(global as any).TEST_WORKFLOWS_PATH = TEST_WORKFLOWS_PATH;
(global as any).TestUtils = TestUtils;

// tests/workflows/ directory already exists in repo
// No beforeEach setup needed - removed per Stage 8 requirements
