/**
 * Ambient declarations for the helpers `tests/setup.ts` installs on `globalThis`.
 *
 * The suites use these without importing them, so without this file every use is an unresolved
 * name. Each declaration takes its type from the helper it mirrors, so a change to a helper's
 * signature reaches the suites rather than being absorbed by `any`.
 */

import type {
  createTestRepository as createTestRepositoryHelper,
  createTestExecutor as createTestExecutorHelper,
  createTestMCPEngine as createTestMCPEngineHelper,
  TestUtils as TestUtilsHelper,
} from "./utils/test-helpers.js";

declare global {
  const createTestRepository: typeof createTestRepositoryHelper;
  const createTestExecutor: typeof createTestExecutorHelper;
  const createTestMCPEngine: typeof createTestMCPEngineHelper;
  const TestUtils: typeof TestUtilsHelper;
  const TEST_USER_ID: string;
  const TEST_WORKFLOWS_PATH: string;
}

export {};
