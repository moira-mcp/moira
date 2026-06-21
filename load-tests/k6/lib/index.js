/**
 * k6 Load Testing Library Index
 *
 * Export all shared utilities for k6 scenarios
 */

// Configuration
export {
  targets,
  getTarget,
  getBaseUrl,
  getApiUrl,
  loadProfiles,
  getLoadProfile,
  httpDefaults,
  rateLimits,
  rateLimitBypass,
} from "./config.js";

// Thresholds
export {
  slaTiers,
  endpointThresholds,
  getThresholdsForEndpoint,
  getThresholdsForTier,
  defaultThresholds,
  criticalThresholds,
  relaxedThresholds,
} from "./thresholds.js";

// Authentication
export {
  generateTestEmail,
  generateTestPassword,
  getLoadTestHeaders,
  registerTestUser,
  loginTestUser,
  getOrCreateTestSession,
  authenticatedRequest,
  authGet,
  authPost,
  authPut,
  authDelete,
  isLoadTestSecretConfigured,
  validateLoadTestEnvironment,
  simpleCookies,
} from "./auth.js";

// HTTP Helpers
export {
  customMetrics,
  checkResponse,
  checkJsonResponse,
  parseJsonBody,
  apiGet,
  apiPost,
  apiGetAuth,
  apiPostAuth,
  apiBatch,
  sleepWithJitter,
  randomSleep,
  formatResponse,
  logRequest,
} from "./http.js";
