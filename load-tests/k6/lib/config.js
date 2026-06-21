/**
 * k6 Load Testing Configuration
 *
 * Target environment configuration (local/staging/prod)
 * and common settings for all k6 scenarios.
 */

/**
 * Target environment definitions
 * Select via TARGET_ENV environment variable
 */
export const targets = {
  local: {
    name: "local",
    baseUrl: __ENV.TARGET_BASE_URL || __ENV.LOCAL_BASE_URL || "http://host.docker.internal:3032",
    description: "Local Docker container",
    timeout: "30s",
  },
  staging: {
    name: "staging",
    baseUrl: __ENV.STAGING_BASE_URL || __ENV.TARGET_BASE_URL,
    description: "Staging environment",
    timeout: "30s",
  },
  prod: {
    name: "prod",
    baseUrl: __ENV.PROD_BASE_URL || __ENV.TARGET_BASE_URL,
    description: "Production environment",
    timeout: "30s",
  },
};

/**
 * Get current target configuration
 * @returns {Object} Target configuration
 */
export function getTarget() {
  const targetEnv = __ENV.TARGET_ENV || "local";
  const target = targets[targetEnv];

  if (!target) {
    throw new Error(
      `Unknown target environment: ${targetEnv}. Valid values: ${Object.keys(targets).join(", ")}`,
    );
  }

  // Allow override of base URL (support both TARGET_BASE_URL and BASE_URL)
  if (__ENV.TARGET_BASE_URL) {
    target.baseUrl = __ENV.TARGET_BASE_URL;
  } else if (__ENV.BASE_URL) {
    target.baseUrl = __ENV.BASE_URL;
  }

  // Validate that base URL is configured for non-local environments
  if (!target.baseUrl && targetEnv !== "local") {
    throw new Error(
      `Base URL not configured for ${targetEnv} environment. ` +
        `Set ${targetEnv.toUpperCase()}_BASE_URL or TARGET_BASE_URL environment variable.`,
    );
  }

  return target;
}

/**
 * Get base URL for current target
 * @returns {string} Base URL
 */
export function getBaseUrl() {
  return getTarget().baseUrl;
}

/**
 * Get API URL for current target
 * @returns {string} API URL
 */
export function getApiUrl() {
  return `${getBaseUrl()}/api`;
}

/**
 * Load profile definitions
 * Matching existing SLAs from BASELINES.md
 */
export const loadProfiles = {
  light: {
    stages: [
      { duration: "2m", target: 10 }, // Ramp up to 10 RPS
      { duration: "3m", target: 10 }, // Stay at 10 RPS
      { duration: "30s", target: 0 }, // Ramp down
    ],
    description: "Light load profile (10 RPS peak)",
  },
  medium: {
    stages: [
      { duration: "5m", target: 50 }, // Ramp up to 50 RPS
      { duration: "10m", target: 50 }, // Stay at 50 RPS
      { duration: "1m", target: 0 }, // Ramp down
    ],
    description: "Medium load profile (50 RPS peak)",
  },
  heavy: {
    stages: [
      { duration: "10m", target: 200 }, // Ramp up to 200 RPS
      { duration: "15m", target: 200 }, // Stay at 200 RPS
      { duration: "2m", target: 0 }, // Ramp down
    ],
    description: "Heavy load profile (200 RPS peak)",
  },
  soak: {
    stages: [
      { duration: "2m", target: 50 }, // Ramp up
      { duration: "30m", target: 50 }, // Sustained load
      { duration: "1m", target: 0 }, // Ramp down
    ],
    description: "Soak test (50 RPS for 30 min)",
  },
};

/**
 * Get load profile by name
 * @param {string} profileName - Profile name (light/medium/heavy/soak)
 * @returns {Object} Load profile
 */
export function getLoadProfile(profileName = "light") {
  const profile = loadProfiles[profileName];
  if (!profile) {
    throw new Error(
      `Unknown load profile: ${profileName}. Valid values: ${Object.keys(loadProfiles).join(", ")}`,
    );
  }
  return profile;
}

/**
 * Rate limit bypass configuration
 * When LOAD_TEST_SECRET is set, adds X-Load-Test header to skip rate limiting
 * Note: X-Load-Test header is also used for authentication bypass,
 * providing a unified load testing mechanism.
 * Set DISABLE_RATE_BYPASS=true to test rate limiting behavior
 */
export const rateLimitBypass = {
  enabled: __ENV.LOAD_TEST_SECRET && __ENV.DISABLE_RATE_BYPASS !== "true",
  secret: __ENV.LOAD_TEST_SECRET || "",
  headerName: "X-Load-Test",
};

/**
 * Build default headers including rate limit bypass if enabled
 */
function buildDefaultHeaders() {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Add rate limit bypass header if secret is available and bypass is enabled
  if (rateLimitBypass.enabled && rateLimitBypass.secret) {
    headers[rateLimitBypass.headerName] = rateLimitBypass.secret;
  }

  return headers;
}

/**
 * Default HTTP options
 */
export const httpDefaults = {
  timeout: "30s",
  headers: buildDefaultHeaders(),
};

/**
 * Rate limit for load testing requests
 * Used to ensure we don't exceed target RPS
 */
export const rateLimits = {
  light: 15, // 15 RPS max
  medium: 75, // 75 RPS max
  heavy: 250, // 250 RPS max
  soak: 60, // 60 RPS max
};
