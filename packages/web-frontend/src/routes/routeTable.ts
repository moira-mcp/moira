/**
 * Every route the web app declares, as data: `App.tsx` renders its routes from this table, and the
 * route-coverage check reads the same table. Each route says how it is explained to a reader:
 *
 * - `screen` — the screen tour that explains it (a guide in the registry with that screen);
 * - `exempt` — not toured, with the reason (sign-in and other standalone pages, redirects);
 * - `deferred` — not toured yet, for a reason tracked as unfinished work (the admin area).
 *
 * Paths are written without the app's base path; `App.tsx` adds it, as the guides' route patterns
 * are matched without it too.
 */

import type { FeatureFlag } from "../types/api-types";

export type RouteCoverage = { screen: string } | { exempt: string } | { deferred: string };

export interface RouteEntry {
  /** Stable key; `App.tsx` maps it to the page it renders. */
  id: string;
  /** The route pattern, without the app's base path. */
  path: string;
  coverage: RouteCoverage;
}

export interface GuardedRouteEntry extends RouteEntry {
  /** Only for signed-in readers. */
  signedIn?: boolean;
  /** Only when the deployment enables this capability. */
  capability?: FeatureFlag;
}

const SIGN_IN = "a sign-in, registration or account-recovery page, seen before the app";

/** Pages outside the app's layout: signing in, recovering an account, consent screens. */
export const STANDALONE_ROUTES = [
  { id: "login", path: "/login", coverage: { exempt: SIGN_IN } },
  { id: "register", path: "/register", coverage: { exempt: SIGN_IN } },
  { id: "registration-success", path: "/registration-success", coverage: { exempt: SIGN_IN } },
  { id: "forgot-password", path: "/forgot-password", coverage: { exempt: SIGN_IN } },
  { id: "reset-password", path: "/reset-password", coverage: { exempt: SIGN_IN } },
  {
    id: "forced-password-reset",
    path: "/force-password-reset",
    coverage: { exempt: "a one-time password change forced before the app opens" },
    signedIn: true,
  },
  { id: "verify-email", path: "/verify-email", coverage: { exempt: SIGN_IN } },
  {
    id: "oauth-authorize",
    path: "/oauth/authorize",
    coverage: { exempt: "an OAuth approval screen an MCP client opens, not a page of the app" },
  },
  {
    id: "oauth-consent",
    path: "/oauth/consent",
    coverage: { exempt: "an OAuth approval screen an MCP client opens, not a page of the app" },
  },
  {
    id: "test-error",
    path: "/test-error",
    coverage: { exempt: "a page that throws on purpose, for the error-boundary tests" },
  },
  {
    id: "invite-accept",
    path: "/invites/:token",
    coverage: { exempt: "a one-time invitation page, opened from an email" },
  },
] as const satisfies readonly GuardedRouteEntry[];

/** The app's screens, for every signed-in reader, inside the main layout. */
export const MAIN_ROUTES = [
  { id: "home", path: "/", coverage: { screen: "home" } },
  { id: "overview", path: "/overview", coverage: { screen: "overview" } },
  { id: "flows", path: "/workflows", coverage: { screen: "flows" } },
  { id: "flow-by-name", path: "/workflows/:handle/:slug", coverage: { screen: "flow" } },
  { id: "flow-by-id", path: "/workflows/:id", coverage: { screen: "flow" } },
  { id: "runs", path: "/executions", coverage: { screen: "runs" } },
  { id: "run", path: "/executions/:id", coverage: { screen: "run" } },
  { id: "notes", path: "/notes", coverage: { screen: "notes" } },
  { id: "playbooks", path: "/playbooks", coverage: { screen: "playbooks" } },
  { id: "artifacts", path: "/artifacts", coverage: { screen: "artifacts" } },
  { id: "settings", path: "/settings", coverage: { screen: "settings" } },
] as const satisfies readonly RouteEntry[];

const ADMIN_DEFERRED = "admin tour postponed; tracked separately";

/** The admin area, for administrators, inside the admin layout. */
export const ADMIN_ROUTES = [
  { id: "admin", path: "/admin", coverage: { deferred: ADMIN_DEFERRED } },
  {
    id: "admin-users",
    path: "/admin/users",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "userManagement",
  },
  {
    id: "admin-user",
    path: "/admin/users/:id",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "userManagement",
  },
  {
    id: "admin-runs",
    path: "/admin/executions",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "multiUserAdmin",
  },
  {
    id: "admin-run",
    path: "/admin/executions/:id",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "multiUserAdmin",
  },
  {
    id: "admin-flows",
    path: "/admin/workflows",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "multiUserAdmin",
  },
  {
    id: "admin-artifacts",
    path: "/admin/artifacts",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "multiUserAdmin",
  },
  {
    id: "admin-reported-artifacts",
    path: "/admin/artifacts/reported",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "multiUserAdmin",
  },
  { id: "admin-audit-log", path: "/admin/audit-log", coverage: { deferred: ADMIN_DEFERRED } },
  { id: "admin-settings", path: "/admin/settings", coverage: { deferred: ADMIN_DEFERRED } },
  {
    id: "admin-global-settings",
    path: "/admin/global-settings",
    coverage: { deferred: ADMIN_DEFERRED },
  },
  {
    id: "admin-deleted-flows",
    path: "/admin/deleted-workflows",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "multiUserAdmin",
  },
  {
    id: "admin-monitoring-test",
    path: "/admin/monitoring-test",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "operationsDevelopment",
  },
  { id: "admin-tokens", path: "/admin/tokens", coverage: { deferred: ADMIN_DEFERRED } },
  {
    id: "admin-operational",
    path: "/admin/operational",
    coverage: { deferred: ADMIN_DEFERRED },
    capability: "adminOperations",
  },
  {
    id: "admin-analytics",
    path: "/admin/analytics",
    coverage: { exempt: "a redirect to the admin dashboard" },
  },
] as const satisfies readonly GuardedRouteEntry[];

/** The bare root, when the app lives under a base path: a redirect to the home screen. */
export const ROOT_REDIRECT = {
  id: "root-redirect",
  path: "/",
  coverage: { exempt: "a redirect to the home screen when the app has a base path" },
} as const satisfies RouteEntry;

export type StandaloneRouteId = (typeof STANDALONE_ROUTES)[number]["id"];
export type MainRouteId = (typeof MAIN_ROUTES)[number]["id"];
export type AdminRouteId = (typeof ADMIN_ROUTES)[number]["id"];

/** Every route, for the coverage check. */
export const ALL_ROUTES: readonly GuardedRouteEntry[] = [
  ...STANDALONE_ROUTES,
  ROOT_REDIRECT,
  ...MAIN_ROUTES,
  ...ADMIN_ROUTES,
];
