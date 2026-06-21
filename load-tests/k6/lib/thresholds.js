/**
 * k6 SLA Thresholds Configuration
 *
 * Based on BASELINES.md performance targets.
 * These thresholds determine test pass/fail status.
 */

/**
 * SLA Tier definitions from BASELINES.md
 *
 * | Tier     | p50      | p95     | p99     | p100    |
 * |----------|----------|---------|---------|---------|
 * | Critical | ≤ 50ms   | ≤ 100ms | ≤ 200ms | ≤ 1s    |
 * | Standard | ≤ 100ms  | ≤ 250ms | ≤ 500ms | ≤ 2s    |
 * | Relaxed  | ≤ 200ms  | ≤ 500ms | ≤ 1s    | ≤ 5s    |
 */
export const slaTiers = {
  critical: {
    p50: 50,
    p95: 100,
    p99: 200,
    p100: 1000,
    errorRate: 0.001, // 0.1%
  },
  standard: {
    p50: 100,
    p95: 250,
    p99: 500,
    p100: 2000,
    errorRate: 0.01, // 1%
  },
  relaxed: {
    p50: 200,
    p95: 500,
    p99: 1000,
    p100: 5000,
    errorRate: 0.05, // 5%
  },
};

/**
 * Endpoint-specific thresholds based on BASELINES.md
 */
export const endpointThresholds = {
  // Health check - Critical tier
  healthCheck: {
    p50: 10,
    p95: 20,
    p99: 50,
    errorRate: 0,
  },

  // Workflows API - Standard tier
  workflows: {
    p50: 50,
    p95: 150,
    p99: 300,
    errorRate: 0.001,
  },

  // Executions API - Standard tier
  executions: {
    p50: 75,
    p95: 200,
    p99: 400,
    errorRate: 0.001,
  },

  // MCP Tools - Standard tier
  mcp: {
    p50: 100,
    p95: 300,
    p99: 500,
    errorRate: 0.005,
  },

  // Full system - Relaxed tier
  full: {
    p50: 100,
    p95: 300,
    p99: 600,
    errorRate: 0.01,
  },
};

/**
 * Generate k6 threshold object for a given endpoint
 * @param {string} endpoint - Endpoint name (healthCheck, workflows, etc.)
 * @param {string} metricName - k6 metric name to apply thresholds to
 * @returns {Object} k6 thresholds object
 */
export function getThresholdsForEndpoint(endpoint, metricName = "http_req_duration") {
  const config = endpointThresholds[endpoint];
  if (!config) {
    throw new Error(`Unknown endpoint for thresholds: ${endpoint}`);
  }

  return {
    [`${metricName}{scenario:${endpoint}}`]: [
      `p(50)<${config.p50}`,
      `p(95)<${config.p95}`,
      `p(99)<${config.p99}`,
    ],
    [`errors{scenario:${endpoint}}`]: [`rate<${config.errorRate}`],
  };
}

/**
 * Generate k6 threshold object for a given SLA tier
 * @param {string} tier - SLA tier (critical, standard, relaxed)
 * @param {string} metricName - k6 metric name to apply thresholds to
 * @returns {Object} k6 thresholds object
 */
export function getThresholdsForTier(tier, metricName = "http_req_duration") {
  const config = slaTiers[tier];
  if (!config) {
    throw new Error(`Unknown SLA tier: ${tier}. Valid: ${Object.keys(slaTiers).join(", ")}`);
  }

  return {
    [metricName]: [
      `p(50)<${config.p50}`,
      `p(95)<${config.p95}`,
      `p(99)<${config.p99}`,
      `p(100)<${config.p100}`,
    ],
    errors: [`rate<${config.errorRate}`],
    http_req_failed: [`rate<${config.errorRate}`],
  };
}

/**
 * Default thresholds for most scenarios
 * Uses Standard tier as baseline
 */
export const defaultThresholds = {
  http_req_duration: [
    "p(50)<100", // 50% of requests under 100ms
    "p(95)<250", // 95% of requests under 250ms
    "p(99)<500", // 99% of requests under 500ms
  ],
  http_req_failed: ["rate<0.01"], // Less than 1% errors
  errors: ["rate<0.01"], // Custom error rate
};

/**
 * Strict thresholds for critical endpoints
 */
export const criticalThresholds = {
  http_req_duration: ["p(50)<50", "p(95)<100", "p(99)<200"],
  http_req_failed: ["rate<0.001"],
  errors: ["rate<0.001"],
};

/**
 * Relaxed thresholds for admin/settings endpoints
 */
export const relaxedThresholds = {
  http_req_duration: ["p(50)<200", "p(95)<500", "p(99)<1000"],
  http_req_failed: ["rate<0.05"],
  errors: ["rate<0.05"],
};
