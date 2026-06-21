/**
 * Test Environment Helpers for Consistent Testing
 * Stage 17: Test Structure Reorganization
 */

import { jest } from "@jest/globals";

/**
 * Setup test environment with consistent configuration
 */
export function setupTestEnvironment() {
  // Clean environment setup
  process.env.NODE_ENV = "test";

  // Disable logging in tests unless explicitly enabled
  if (!process.env.TEST_LOG_LEVEL) {
    process.env.LOG_LEVEL = "silent";
  }

  // Set test-specific storage paths
  if (!process.env.TEST_STORAGE_PATH) {
    process.env.GRAPH_STORAGE_PATH = "./.test-graph-storage";
  }

  // Ensure clean test state
  jest.clearAllMocks();
}

/**
 * Clean up test environment after tests
 */
export function cleanupTestEnvironment() {
  jest.clearAllMocks();
  jest.restoreAllMocks();

  // Clean up any test-specific environment variables
  delete process.env.TEST_STORAGE_PATH;
}

/**
 * Create isolated test environment for each test suite
 */
export function createIsolatedTestEnvironment(testSuiteName: string) {
  const originalEnv = process.env;

  beforeEach(() => {
    // Setup clean environment for each test
    setupTestEnvironment();

    // Set test suite specific storage
    process.env.GRAPH_STORAGE_PATH = `./.test-graph-storage-${testSuiteName}`;
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  afterAll(() => {
    // Restore original environment
    process.env = originalEnv;
  });
}

/**
 * Performance monitoring for test execution
 */
export class TestPerformanceMonitor {
  private startTime: number;
  private testName: string;

  constructor(testName: string) {
    this.testName = testName;
    this.startTime = Date.now();
  }

  finish(): number {
    const duration = Date.now() - this.startTime;
    if (duration > 5000) {
      console.warn(`Slow test detected: ${this.testName} took ${duration}ms`);
    }
    return duration;
  }
}

/**
 * Memory monitoring for test suites
 */
export function monitorTestMemory(testSuiteName: string) {
  let initialMemory: NodeJS.MemoryUsage;

  beforeAll(() => {
    if (global.gc) {
      global.gc();
    }
    initialMemory = process.memoryUsage();
  });

  afterAll(() => {
    if (global.gc) {
      global.gc();
    }

    const finalMemory = process.memoryUsage();
    const heapGrowth = finalMemory.heapUsed - initialMemory.heapUsed;

    if (heapGrowth > 50 * 1024 * 1024) {
      // 50MB threshold
      console.warn(
        `Memory leak detected in ${testSuiteName}: ${Math.round(heapGrowth / 1024 / 1024)}MB heap growth`,
      );
    }
  });
}
