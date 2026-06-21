/**
 * Centralized URL Configuration
 * All URLs are computed from MOIRA_HOST environment variable
 */

/**
 * Check if running in test environment
 */
function isTestEnv(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.JEST_WORKER_ID !== undefined ||
    process.env.TEST_ENV === "true"
  );
}

/**
 * Lightweight self-host check. Read locally (not via env.ts getDeploymentMode)
 * to avoid a urls.ts ↔ env.ts import cycle. Defaults to self-host; only an
 * explicit "saas" opts out (invalid values are validated in env.ts).
 */
function isSelfHostMode(): boolean {
  return (process.env.DEPLOYMENT_MODE ?? "self-host").trim().toLowerCase() !== "saas";
}

/**
 * Get the host from environment
 * MOIRA_HOST is REQUIRED, no fallback
 * Example: moira.example.com or localhost:8080
 */
export function getHost(): string {
  const host = process.env.MOIRA_HOST;
  if (!host) {
    // In test environment, return dummy host
    if (isTestEnv()) {
      return "localhost:3030";
    }
    throw new Error("MOIRA_HOST environment variable is required");
  }
  return host;
}

/**
 * Set the host in environment
 */
export function setHost(host: string): void {
  if (!host) {
    throw new Error("MOIRA_HOST cannot be empty");
  }
  process.env.MOIRA_HOST = host;
}

/**
 * Get the protocol based on host
 * localhost uses http, everything else uses https
 */
export function getProtocol(): string {
  const host = getHost();
  return host.includes("localhost") ? "http" : "https";
}

/**
 * Get the base URL for the application
 */
export function getBaseUrl(): string {
  return `${getProtocol()}://${getHost()}`;
}

/**
 * Get the MCP endpoint URL
 */
export function getMcpUrl(): string {
  return `${getBaseUrl()}/mcp`;
}

/**
 * Get the API base URL
 */
export function getApiUrl(): string {
  return `${getBaseUrl()}/api`;
}

/**
 * Get the auth callback URL for OAuth (used by Better Auth)
 */
export function getAuthUrl(): string {
  return `${getBaseUrl()}/api/auth`;
}

/**
 * Check if running in production (HTTPS)
 */
export function isProduction(): boolean {
  return getProtocol() === "https";
}

/**
 * Get static artifacts domain
 * STATIC_ARTIFACTS_DOMAIN is REQUIRED, no fallback
 * Example: static.example.com or static.localhost:8080
 */
export function getStaticArtifactsDomain(): string {
  const domain = process.env.STATIC_ARTIFACTS_DOMAIN;
  if (!domain) {
    if (isTestEnv()) {
      return "static.localhost";
    }
    throw new Error("STATIC_ARTIFACTS_DOMAIN environment variable is required");
  }
  return domain;
}

/**
 * Set static artifacts domain in environment (for build-time injection)
 */
export function setStaticArtifactsDomain(domain: string): void {
  if (!domain) {
    throw new Error("STATIC_ARTIFACTS_DOMAIN cannot be empty");
  }
  process.env.STATIC_ARTIFACTS_DOMAIN = domain;
}

/**
 * Get URL for an artifact by UUID.
 *
 * Each artifact is served on its own origin via a per-artifact subdomain
 * (`{uuid}.{domain}`), giving it isolated storage / ServiceWorker / cookies.
 * This is the only serving mode — there is no path-based fallback.
 *   http://{uuid}.{domain}/   (localhost — subdomains resolve to loopback, no cert)
 *   https://{uuid}.{domain}/  (deployed — requires the *.{domain} wildcard cert)
 */
export function getArtifactUrl(uuid: string): string {
  const domain = getStaticArtifactsDomain();
  const protocol = domain.includes("localhost") ? "http" : "https";
  return `${protocol}://${uuid}.${domain}/`;
}

/**
 * Resolve an artifact UUID from the request host, if the host is a per-artifact
 * subdomain of the static artifacts domain (`{uuid}.{STATIC_ARTIFACTS_DOMAIN}`).
 *
 * Returns the uuid (the left-most label) when the host is a direct subdomain of
 * the configured static domain, or null otherwise (e.g. the bare static domain,
 * the app domain, or localhost path-based serving).
 *
 * The hostname may include a port (e.g. from the Host header); it is stripped
 * before comparison.
 */
export function resolveArtifactUuidFromHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) {
    return null;
  }
  const host = hostHeader.split(":")[0].toLowerCase();
  const domain = getStaticArtifactsDomain().split(":")[0].toLowerCase();

  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) {
    return null;
  }
  const label = host.slice(0, -suffix.length);
  // Must be exactly one label (the uuid) — no nested subdomains, no empty.
  if (!label || label.includes(".")) {
    return null;
  }
  return label;
}

/**
 * Get contact email from environment
 * CONTACT_EMAIL is REQUIRED for production builds
 */
export function getContactEmail(): string {
  const email = process.env.CONTACT_EMAIL;
  if (!email) {
    if (isTestEnv()) {
      return "support@localhost";
    }
    // Self-host: fall back to a safe local default instead of aborting.
    // saas keeps the strict requirement.
    if (isSelfHostMode()) {
      return "support@localhost";
    }
    throw new Error("CONTACT_EMAIL environment variable is required");
  }
  return email;
}

/**
 * Set contact email in environment (for build-time injection)
 */
export function setContactEmail(email: string): void {
  if (!email) {
    throw new Error("CONTACT_EMAIL cannot be empty");
  }
  process.env.CONTACT_EMAIL = email;
}

/**
 * Validate URL configuration
 * Called by validateEnvConfig() in env.ts
 * @internal
 */
export function validateHostFormat(): void {
  const host = getHost(); // Will throw if MOIRA_HOST not set

  // Validate host format (no protocol, no path)
  if (host.includes("://")) {
    throw new Error(`MOIRA_HOST should be host only, not URL: ${host}`);
  }
  if (host.includes("/")) {
    throw new Error(`MOIRA_HOST should not contain path: ${host}`);
  }

  // Validate resulting URL
  try {
    new URL(getBaseUrl());
  } catch {
    throw new Error(`Invalid MOIRA_HOST configuration: ${host}`);
  }
}
