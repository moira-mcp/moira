/**
 * Centralized Environment Variables Configuration (Singleton)
 *
 * ALL env variables must be accessed through this module.
 * Direct process.env access is forbidden by ESLint rule.
 *
 * SINGLETON: First access to any getter triggers validation and logging.
 *
 * @see docs/deployment/ENVIRONMENT_VARIABLES.md
 */

import { createLogger } from "../logging/logger.js";
import { validateHostFormat } from "./urls.js";
import { loadPersistedSecrets } from "./secrets-bootstrap.js";
import dotenv from "dotenv";
import path from "path";

const logger = createLogger({ component: "config" });

/**
 * Deployment mode.
 *
 * - `self-host`: single-user or private-team install without SaaS scaffolding
 *   (open registration, email-verification gate, legal consents are off by default).
 * - `saas`: hosted multi-tenant deployment with the full SaaS behavior.
 *
 * Default is `self-host` so the open-source build runs out of the box.
 */
export type DeploymentMode = "self-host" | "saas";

export const DEPLOYMENT_MODES: readonly DeploymentMode[] = ["self-host", "saas"] as const;

export const DEFAULT_DEPLOYMENT_MODE: DeploymentMode = "self-host";

/** Message shown when DEPLOYMENT_MODE is unset on a public host. */
export const UNSET_MODE_PUBLIC_HOST_MESSAGE =
  "DEPLOYMENT_MODE is unset on a non-localhost host. It defaults to 'self-host', which " +
  "DISABLES the SaaS auth gates (email verification, legal consents, open-registration closure). " +
  "Set DEPLOYMENT_MODE=saas for a hosted multi-tenant deployment, or =self-host to confirm a " +
  "single-user/private install.";

/**
 * Pure decision for the unset-DEPLOYMENT_MODE safeguard, extracted for testing.
 *
 * DEPLOYMENT_MODE defaults to the LESS strict mode (self-host), so an unset value
 * on a hosted deployment must never SILENTLY downgrade the SaaS auth gates.
 *   - "error": production + public (non-localhost) host + unset → refuse to boot
 *     (force an explicit choice).
 *   - "warn": non-production + public host + unset → warn loudly, but boot.
 *   - "ok": mode is set, or host is local/empty → nothing to do.
 */
export function evaluateUnsetModeSafeguard(params: {
  host: string;
  deploymentModeSet: boolean;
  isProduction: boolean;
}): "error" | "warn" | "ok" {
  const { host, deploymentModeSet, isProduction } = params;
  if (deploymentModeSet) return "ok";
  const looksPublic = host !== "" && !host.startsWith("localhost") && !host.startsWith("127.");
  if (!looksPublic) return "ok";
  return isProduction ? "error" : "warn";
}

/**
 * Config Singleton - single source of truth for all env variables
 */
class ConfigSingleton {
  private initialized = false;

  // ============================================================================
  // Database
  // ============================================================================

  getDbPath(): string {
    this.ensureInitialized();
    return process.env.DB_PATH || "./data/moira.db";
  }

  /**
   * Ordered list of workflow-catalog base directories to load and merge.
   *
   * Resolved from `WORKFLOWS_DIRS` (colon-separated list, PATH-style); falls back to the single
   * `WORKFLOWS_DIR`; and finally to the bundled default `./workflows/production`. Directories are
   * applied in order — a LATER directory overrides an earlier one on an (owner, slug) collision —
   * so an operator's private folder, listed last, can extend or shadow the bundled public catalog.
   * Empty/whitespace-only segments are dropped.
   */
  getWorkflowsDirs(): string[] {
    this.ensureInitialized();
    const raw = process.env.WORKFLOWS_DIRS;
    if (raw && raw.trim().length > 0) {
      const dirs = raw
        .split(":")
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      if (dirs.length > 0) return dirs;
    }
    const single = process.env.WORKFLOWS_DIR;
    if (single && single.trim().length > 0) return [single.trim()];
    return ["./workflows/production"];
  }

  // ============================================================================
  // Authentication
  // ============================================================================

  getBetterAuthSecret(): string {
    this.ensureInitialized();
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) {
      // In test environment, return dummy secret
      if (this.isTestEnv()) {
        return "test-secret-for-unit-tests-only";
      }
      throw new Error("BETTER_AUTH_SECRET environment variable is required");
    }
    return secret;
  }

  private isTestEnv(): boolean {
    return (
      process.env.NODE_ENV === "test" ||
      process.env.JEST_WORKER_ID !== undefined ||
      process.env.TEST_ENV === "true"
    );
  }

  getGitHubClientId(): string | undefined {
    this.ensureInitialized();
    return process.env.GITHUB_CLIENT_ID;
  }

  getGitHubClientSecret(): string | undefined {
    this.ensureInitialized();
    return process.env.GITHUB_CLIENT_SECRET;
  }

  getGoogleClientId(): string | undefined {
    this.ensureInitialized();
    return process.env.GOOGLE_CLIENT_ID;
  }

  getGoogleClientSecret(): string | undefined {
    this.ensureInitialized();
    return process.env.GOOGLE_CLIENT_SECRET;
  }

  // ============================================================================
  // Telegram
  // ============================================================================

  getTelegramEncryptionKey(): string | undefined {
    this.ensureInitialized();
    return process.env.TELEGRAM_ENCRYPTION_KEY;
  }

  getTelegramApiTimeout(): number {
    this.ensureInitialized();
    const timeout = process.env.TELEGRAM_API_TIMEOUT;
    return timeout ? parseInt(timeout, 10) : 30000;
  }

  // ============================================================================
  // Email
  // ============================================================================

  getBrevoApiKey(): string | undefined {
    this.ensureInitialized();
    return process.env.BREVO_API_KEY;
  }

  getEmailFrom(): string {
    this.ensureInitialized();
    const email = process.env.EMAIL_FROM;
    if (!email) {
      if (this.isTestEnv()) {
        return "test@localhost";
      }
      // Self-host: a fresh install has no mail sender configured. Fall back to
      // a safe local default instead of aborting. saas keeps the strict error.
      if (this.getDeploymentMode() === "self-host") {
        return "noreply@localhost";
      }
      throw new Error("EMAIL_FROM environment variable is required");
    }
    return email;
  }

  getEmailFromName(): string {
    this.ensureInitialized();
    return process.env.EMAIL_FROM_NAME || "MCP Moira";
  }

  // ============================================================================
  // Server Ports
  // ============================================================================

  getWebBackendPort(): number {
    this.ensureInitialized();
    const port = process.env.WEB_BACKEND_PORT;
    return port ? parseInt(port, 10) : 4201;
  }

  getMcpPort(): number {
    this.ensureInitialized();
    const port = process.env.MCP_PORT;
    return port ? parseInt(port, 10) : 4202;
  }

  getMetricsPort(): number {
    this.ensureInitialized();
    const port = process.env.METRICS_PORT;
    return port ? parseInt(port, 10) : 9090;
  }

  // ============================================================================
  // Logging
  // ============================================================================

  getLogLevelEnv(): string {
    this.ensureInitialized();
    return process.env.LOG_LEVEL || "info";
  }

  /**
   * Web UI base-path prefix, from the APP_BASE_PATH build/runtime value.
   * "/" (default, self-host) → "" (Web UI at root); "/app" (our hosted deploy)
   * → "/app" (trailing slash stripped). Used by the backend for OAuth redirect
   * and email-callback URL construction so they match the frontend's base path.
   */
  getAppPrefix(): string {
    this.ensureInitialized();
    const raw = process.env.APP_BASE_PATH;
    if (!raw || raw === "/") return "";
    return raw.replace(/\/+$/, "");
  }

  isLogSqlEnabled(): boolean {
    this.ensureInitialized();
    return process.env.LOG_SQL === "true";
  }

  // ============================================================================
  // Development/Testing
  // ============================================================================

  getNodeEnv(): string {
    this.ensureInitialized();
    return process.env.NODE_ENV || "development";
  }

  isRateLimitDisabled(): boolean {
    this.ensureInitialized();
    return process.env.DISABLE_RATE_LIMIT === "true";
  }

  getRateLimitWhitelist(): string[] {
    this.ensureInitialized();
    const whitelist = process.env.RATE_LIMIT_WHITELIST;
    if (!whitelist) return [];
    return whitelist.split(",").map((ip) => ip.trim());
  }

  isTestEnvironment(): boolean {
    this.ensureInitialized();
    return (
      process.env.NODE_ENV === "test" ||
      process.env.JEST_WORKER_ID !== undefined ||
      process.env.TEST_ENV === "true"
    );
  }

  // ============================================================================
  // Deployment Mode
  // ============================================================================

  /**
   * Resolve the deployment mode from DEPLOYMENT_MODE.
   *
   * Defaults to `self-host` when unset. An unrecognized value is a hard error
   * (fail fast) rather than a silent fallback, since the mode gates security
   * behavior and a typo must not silently relax it.
   */
  getDeploymentMode(): DeploymentMode {
    this.ensureInitialized();
    const raw = process.env.DEPLOYMENT_MODE;
    if (!raw) {
      return DEFAULT_DEPLOYMENT_MODE;
    }
    const normalized = raw.trim().toLowerCase();
    if ((DEPLOYMENT_MODES as readonly string[]).includes(normalized)) {
      return normalized as DeploymentMode;
    }
    throw new Error(
      `Invalid DEPLOYMENT_MODE "${raw}". Allowed values: ${DEPLOYMENT_MODES.join(", ")}`,
    );
  }

  // ============================================================================
  // Load Testing
  // ============================================================================

  /**
   * Get load test secret for authenticating load test requests
   * Used with X-Load-Test header to identify legitimate load test traffic
   */
  getLoadTestSecret(): string | undefined {
    this.ensureInitialized();
    return process.env.LOAD_TEST_SECRET;
  }

  /**
   * Check if load test authentication bypass is enabled
   * Requires both LOAD_TEST_SECRET and ENABLE_LOAD_TEST_AUTH to be set
   */
  isLoadTestAuthEnabled(): boolean {
    this.ensureInitialized();
    return process.env.ENABLE_LOAD_TEST_AUTH === "true" && !!process.env.LOAD_TEST_SECRET;
  }

  // ============================================================================
  // Trusted Origins
  // ============================================================================

  getExtraTrustedOrigins(): string[] {
    this.ensureInitialized();
    const origins = process.env.EXTRA_TRUSTED_ORIGINS;
    if (!origins) return [];
    return origins.split(",").filter(Boolean);
  }

  getCorsAllowedOrigins(): string[] {
    this.ensureInitialized();
    const origins = process.env.CORS_ALLOWED_ORIGINS;
    if (!origins) return [];
    return origins
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
  }

  // ============================================================================
  // Paths
  // ============================================================================

  getDocsDir(): string {
    this.ensureInitialized();
    return process.env.DOCS_DIR || "./docs";
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.loadEnv();
    this.initialized = true;

    // Skip validation in test environment
    if (this.isTestEnv()) {
      // In tests, just log that we're in test mode and skip validation
      logger.debug("Config initialized in test mode - skipping validation");
      return;
    }

    // Validate required env vars
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!process.env.MOIRA_HOST) errors.push("MOIRA_HOST");
    if (!process.env.BETTER_AUTH_SECRET) errors.push("BETTER_AUTH_SECRET");
    if (!process.env.DB_PATH) warnings.push("DB_PATH not set, using default: ./data/moira.db");
    if (!process.env.BREVO_API_KEY)
      warnings.push("BREVO_API_KEY not set - email service will use test mode");
    if (!process.env.GITHUB_CLIENT_ID)
      warnings.push("GitHub OAuth not configured - social login disabled");
    if (!process.env.TELEGRAM_ENCRYPTION_KEY) {
      errors.push("TELEGRAM_ENCRYPTION_KEY not set - Telegram credentials won't be encrypted");
    } else if (process.env.TELEGRAM_ENCRYPTION_KEY === "0123456789abcdef".repeat(4)) {
      const message = "TELEGRAM_ENCRYPTION_KEY is weak";
      const type = process.env.NODE_ENV === "development" ? warnings : errors;
      type.push(message);
    }

    // Defense-in-depth: DEPLOYMENT_MODE defaults to the LESS strict mode
    // (self-host), so it must never SILENTLY downgrade a hosted deployment. On a
    // public (non-localhost) host with an unset mode, the SaaS auth gates (email
    // verification, legal consents, open-registration closure) would be OFF.
    //   - production: REFUSE TO BOOT — force the operator to choose explicitly.
    //     A legitimate public self-host sets DEPLOYMENT_MODE=self-host (one line);
    //     a SaaS host sets =saas. Either way the choice is intentional, not silent.
    //   - non-production: warn loudly (don't break local/dev runs).
    const safeguard = evaluateUnsetModeSafeguard({
      host: process.env.MOIRA_HOST || "",
      deploymentModeSet: !!process.env.DEPLOYMENT_MODE,
      isProduction: process.env.NODE_ENV === "production",
    });
    if (safeguard === "error") {
      errors.push(UNSET_MODE_PUBLIC_HOST_MESSAGE);
    } else if (safeguard === "warn") {
      logger.warn(UNSET_MODE_PUBLIC_HOST_MESSAGE);
    }

    // Log warnings
    for (const warning of warnings) {
      logger.warn(warning);
    }

    // Throw if required missing
    if (errors.length > 0) {
      throw new Error(`Missing required environment variables: ${errors.join(", ")}`);
    }

    // Validate URL format
    validateHostFormat();

    // Log startup config - read from methods (which now skip re-initialization)
    this.logConfig();
  }

  get envFileFolder(): string {
    return process.env.ENV_FILE_FOLDER ?? ".";
  }

  private loadEnv() {
    const envFileSuffix = process.env.NODE_ENV === "development" ? ".local" : "";
    const envPath = path.resolve(this.envFileFolder, `.env${envFileSuffix}`);
    logger.info(`Loading config from ${envPath}`);
    dotenv.config({ path: envPath });
    // Load self-host secrets generated on first start (does not override
    // explicit env / .env values). No-op when the file is absent (e.g. saas).
    loadPersistedSecrets();
  }

  private logConfig(): void {
    logger.info("Config initialized", {
      deploymentMode: this.getDeploymentMode(),
      dbPath: this.getDbPath(),
      nodeEnv: this.getNodeEnv(),
      logLevel: this.getLogLevelEnv(),
      webBackendPort: this.getWebBackendPort(),
      mcpPort: this.getMcpPort(),
      emailConfigured: !!this.getBrevoApiKey(),
      githubOAuthConfigured: !!this.getGitHubClientId(),
      telegramEncryptionConfigured: !!this.getTelegramEncryptionKey(),
    });
  }
}

// Singleton instance
const config = new ConfigSingleton();

// ============================================================================
// Exported functions (delegate to singleton)
// ============================================================================

export function getDbPath(): string {
  return config.getDbPath();
}
export function getWorkflowsDirs(): string[] {
  return config.getWorkflowsDirs();
}
export function getBetterAuthSecret(): string {
  return config.getBetterAuthSecret();
}
export function getGitHubClientId(): string | undefined {
  return config.getGitHubClientId();
}
export function getGitHubClientSecret(): string | undefined {
  return config.getGitHubClientSecret();
}
export function getGoogleClientId(): string | undefined {
  return config.getGoogleClientId();
}
export function getGoogleClientSecret(): string | undefined {
  return config.getGoogleClientSecret();
}
export function getTelegramEncryptionKey(): string | undefined {
  return config.getTelegramEncryptionKey();
}
export function getTelegramApiTimeout(): number {
  return config.getTelegramApiTimeout();
}
export function getBrevoApiKey(): string | undefined {
  return config.getBrevoApiKey();
}
export function getEmailFrom(): string {
  return config.getEmailFrom();
}
export function getEmailFromName(): string {
  return config.getEmailFromName();
}
export function getWebBackendPort(): number {
  return config.getWebBackendPort();
}
export function getMcpPort(): number {
  return config.getMcpPort();
}
export function getMetricsPort(): number {
  return config.getMetricsPort();
}
export function getLogLevelEnv(): string {
  return config.getLogLevelEnv();
}
export function getAppPrefix(): string {
  return config.getAppPrefix();
}
export function isLogSqlEnabled(): boolean {
  return config.isLogSqlEnabled();
}
export function getNodeEnv(): string {
  return config.getNodeEnv();
}
export function isRateLimitDisabled(): boolean {
  return config.isRateLimitDisabled();
}
export function getRateLimitWhitelist(): string[] {
  return config.getRateLimitWhitelist();
}
export function isTestEnvironment(): boolean {
  return config.isTestEnvironment();
}
export function getDeploymentMode(): DeploymentMode {
  return config.getDeploymentMode();
}
export function isSelfHost(): boolean {
  return config.getDeploymentMode() === "self-host";
}
export function isSaas(): boolean {
  return config.getDeploymentMode() === "saas";
}
export function getLoadTestSecret(): string | undefined {
  return config.getLoadTestSecret();
}
export function isLoadTestAuthEnabled(): boolean {
  return config.isLoadTestAuthEnabled();
}
export function getDocsDir(): string {
  return config.getDocsDir();
}
export function getExtraTrustedOrigins(): string[] {
  return config.getExtraTrustedOrigins();
}
export function getCorsAllowedOrigins(): string[] {
  return config.getCorsAllowedOrigins();
}

/**
 * Read system prompt from docs/SYSTEM-PROMPT.md
 * Single source of truth for agent instructions
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export function getSystemPrompt(): string {
  const docsDir = getDocsDir();
  const filePath = join(docsDir, "SYSTEM-PROMPT.md");

  if (!existsSync(filePath)) {
    return "MCP Moira - Agent Workflow Engine. Use get_help tool for documentation.";
  }

  return readFileSync(filePath, "utf-8");
}

/**
 * @deprecated Validation happens automatically on first config access
 */
export function validateEnvConfig(): void {
  // Just trigger initialization by accessing any config value
  config.getDbPath();
}
