/**
 * Centralized Configuration Module
 *
 * ALL environment variables must be accessed through this module.
 * Direct process.env access is forbidden by ESLint rule.
 */

// URL configuration
export {
  getHost,
  getProtocol,
  getBaseUrl,
  getMcpUrl,
  getApiUrl,
  getAuthUrl,
  isProduction,
  validateHostFormat,
  getStaticArtifactsDomain,
  setStaticArtifactsDomain,
  getArtifactUrl,
  resolveArtifactUuidFromHost,
  getContactEmail,
  setContactEmail,
  setHost,
} from "./urls.js";

// MCP Server Version (#196)
export { setMcpServerVersion, getMcpServerVersion } from "./mcp-version.js";

// Environment variables
export {
  // Database
  getDbPath,
  // Workflow catalog
  getWorkflowsDirs,
  // Authentication
  getBetterAuthSecret,
  getGitHubClientId,
  getGitHubClientSecret,
  // Telegram
  getTelegramEncryptionKey,
  getTelegramApiTimeout,
  // Email
  getBrevoApiKey,
  getEmailFrom,
  getEmailFromName,
  // Server Ports
  getWebBackendPort,
  getMcpPort,
  getMetricsPort,
  // Logging
  getLogLevelEnv,
  getAppPrefix,
  isLogSqlEnabled,
  // Development/Testing
  getNodeEnv,
  isRateLimitDisabled,
  getRateLimitWhitelist,
  isTestEnvironment,
  // CORS / trusted origins
  getExtraTrustedOrigins,
  getCorsAllowedOrigins,
  // Deployment Mode
  getDeploymentMode,
  isSelfHost,
  isSaas,
  // Load Testing
  getLoadTestSecret,
  isLoadTestAuthEnabled,
  // Paths
  getDocsDir,
  // System Prompt
  getSystemPrompt,
  // Validation (deprecated - happens automatically)
  validateEnvConfig,
} from "./env.js";

export type { DeploymentMode } from "./env.js";
export {
  DEPLOYMENT_MODES,
  DEFAULT_DEPLOYMENT_MODE,
  evaluateUnsetModeSafeguard,
  UNSET_MODE_PUBLIC_HOST_MESSAGE,
} from "./env.js";

// Self-host first-start secret bootstrap
export {
  getSecretsFilePath,
  loadPersistedSecrets,
  bootstrapSelfHostSecrets,
  type GeneratedSecret,
} from "./secrets-bootstrap.js";
