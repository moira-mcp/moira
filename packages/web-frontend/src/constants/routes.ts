/**
 * Application Routes
 * Centralized route constants for consistent navigation
 *
 * The Web UI base path is configurable at build time via the `APP_BASE_PATH`
 * build-arg (webpack DefinePlugin → `process.env.APP_BASE_PATH`):
 *   - `/`    (default, self-host): Web UI served at the site root.
 *   - `/app` (our hosted deploy): Web UI served under `/app`, brand landing at `/`.
 *
 * `buildRoutes(appPrefix)` is a PURE function so the route derivation can be
 * unit-tested for both modes without relying on the DefinePlugin-baked value.
 */

/**
 * Normalize an APP_BASE_PATH build value into a route prefix.
 * `/` → `""` (root mode), `/app` or `/app/` → `/app` (no trailing slash).
 */
export function normalizeAppPrefix(base: string | undefined): string {
  if (!base || base === "/") return "";
  // Strip trailing slashes; ensure a single leading slash.
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export interface RoutesShape {
  LOGIN: string;
  REGISTER: string;
  OAUTH_AUTHORIZE: string;
  FORCED_PASSWORD_RESET: string;
  DASHBOARD: string;
  WORKFLOWS: string;
  EXECUTIONS: string;
  SETTINGS: string;
  INVITE_ACCEPT: string;
  NOTES: string;
  ADMIN: string;
  ADMIN_USERS: string;
  ADMIN_EXECUTIONS: string;
  ADMIN_WORKFLOWS: string;
  ADMIN_DELETED_WORKFLOWS: string;
  ADMIN_SETTINGS: string;
  ADMIN_MONITORING_TEST: string;
  ADMIN_TOKENS: string;
  ADMIN_ANALYTICS: string;
}

/** Admin sub-prefix, appended after the app prefix. */
export const ADMIN_PREFIX = "/admin";

/**
 * Build the full route table from an app prefix.
 * Pure — `buildRoutes("")` yields root routes, `buildRoutes("/app")` yields
 * `/app`-prefixed routes. DASHBOARD is `/` (root) or `/app/` (app mode).
 */
export function buildRoutes(appPrefix: string): RoutesShape {
  const admin = `${appPrefix}${ADMIN_PREFIX}`;
  return {
    // Auth routes
    LOGIN: `${appPrefix}/login`,
    REGISTER: `${appPrefix}/register`,
    OAUTH_AUTHORIZE: `${appPrefix}/oauth/authorize`,
    FORCED_PASSWORD_RESET: `${appPrefix}/force-password-reset`,

    // App routes
    DASHBOARD: appPrefix === "" ? "/" : `${appPrefix}/`,
    WORKFLOWS: `${appPrefix}/workflows`,
    EXECUTIONS: `${appPrefix}/executions`,
    SETTINGS: `${appPrefix}/settings`,
    INVITE_ACCEPT: `${appPrefix}/invites/:token`,
    NOTES: `${appPrefix}/notes`,

    // Admin routes
    ADMIN: admin,
    ADMIN_USERS: `${admin}/users`,
    ADMIN_EXECUTIONS: `${admin}/executions`,
    ADMIN_WORKFLOWS: `${admin}/workflows`,
    ADMIN_DELETED_WORKFLOWS: `${admin}/deleted-workflows`,
    ADMIN_SETTINGS: `${admin}/settings`,
    ADMIN_MONITORING_TEST: `${admin}/monitoring-test`,
    ADMIN_TOKENS: `${admin}/tokens`,
    ADMIN_ANALYTICS: `${admin}/analytics`,
  };
}

/**
 * The build-time app prefix, derived from the `APP_BASE_PATH` build-arg.
 * DefinePlugin substitutes `process.env.APP_BASE_PATH` as a string literal at
 * compile time; default `/` when unset.
 */
export const APP_PREFIX = normalizeAppPrefix(process.env.APP_BASE_PATH ?? "/");

export const ROUTES: RoutesShape = buildRoutes(APP_PREFIX);
