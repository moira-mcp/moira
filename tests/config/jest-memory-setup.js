/**
 * Jest memory optimization setup
 * Addresses memory crashes in integration tests
 */

// Mark test environment
process.env.IS_TEST_ENVIRONMENT = "true";

// Increase Node.js memory limits for Jest workers
process.env.NODE_OPTIONS = "--max-old-space-size=16384 --experimental-vm-modules";

// Memory monitoring
const originalGC = global.gc;
let memoryWarningThreshold = 1024 * 1024 * 1024; // 1GB

if (typeof originalGC === "function") {
  global.gc = function (...args) {
    const memUsage = process.memoryUsage();
    if (memUsage.heapUsed > memoryWarningThreshold) {
      console.warn(`High memory usage detected: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    }
    return originalGC.apply(this, args);
  };
}

// Force garbage collection between test suites
if (typeof global.gc === "function") {
  afterEach(() => {
    if (global.gc) {
      global.gc();
    }
  });
}
