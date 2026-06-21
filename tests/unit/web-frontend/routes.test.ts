import {
  buildRoutes,
  normalizeAppPrefix,
} from "../../../packages/web-frontend/src/constants/routes";

/**
 * Guards the configurable Web-UI base path (APP_BASE_PATH build-arg).
 * Tests the PURE factory `buildRoutes(appPrefix)` directly — the module-level
 * `ROUTES`/`APP_PREFIX` are DefinePlugin-baked at webpack build time and can't be
 * exercised for both modes from Jest, so the factory is the testable contract.
 *
 * "/app" is our hosted production mode; without these guards a `/app` regression
 * would ship silently (the full suite runs in "/" self-host mode by default).
 */

describe("normalizeAppPrefix", () => {
  it("maps root '/' to empty prefix", () => {
    expect(normalizeAppPrefix("/")).toBe("");
  });

  it("maps undefined/empty to empty prefix", () => {
    expect(normalizeAppPrefix(undefined)).toBe("");
    expect(normalizeAppPrefix("")).toBe("");
  });

  it("strips trailing slash from /app/", () => {
    expect(normalizeAppPrefix("/app/")).toBe("/app");
  });

  it("keeps /app as-is", () => {
    expect(normalizeAppPrefix("/app")).toBe("/app");
  });

  it("adds a leading slash when missing", () => {
    expect(normalizeAppPrefix("app")).toBe("/app");
  });
});

describe("buildRoutes — self-host (root) mode", () => {
  const r = buildRoutes("");

  it("auth routes are root-relative", () => {
    expect(r.LOGIN).toBe("/login");
    expect(r.REGISTER).toBe("/register");
    expect(r.OAUTH_AUTHORIZE).toBe("/oauth/authorize");
    expect(r.FORCED_PASSWORD_RESET).toBe("/force-password-reset");
  });

  it("DASHBOARD is the bare root", () => {
    expect(r.DASHBOARD).toBe("/");
  });

  it("app routes are root-relative", () => {
    expect(r.WORKFLOWS).toBe("/workflows");
    expect(r.EXECUTIONS).toBe("/executions");
    expect(r.SETTINGS).toBe("/settings");
    expect(r.INVITE_ACCEPT).toBe("/invites/:token");
    expect(r.NOTES).toBe("/notes");
  });

  it("admin routes are rooted at /admin", () => {
    expect(r.ADMIN).toBe("/admin");
    expect(r.ADMIN_USERS).toBe("/admin/users");
    expect(r.ADMIN_EXECUTIONS).toBe("/admin/executions");
    expect(r.ADMIN_WORKFLOWS).toBe("/admin/workflows");
    expect(r.ADMIN_ANALYTICS).toBe("/admin/analytics");
  });
});

describe("buildRoutes — /app (our hosted) mode", () => {
  const r = buildRoutes("/app");

  it("auth routes carry the /app prefix", () => {
    expect(r.LOGIN).toBe("/app/login");
    expect(r.REGISTER).toBe("/app/register");
    expect(r.OAUTH_AUTHORIZE).toBe("/app/oauth/authorize");
    expect(r.FORCED_PASSWORD_RESET).toBe("/app/force-password-reset");
  });

  it("DASHBOARD is /app/", () => {
    expect(r.DASHBOARD).toBe("/app/");
  });

  it("app routes carry the /app prefix", () => {
    expect(r.WORKFLOWS).toBe("/app/workflows");
    expect(r.EXECUTIONS).toBe("/app/executions");
    expect(r.SETTINGS).toBe("/app/settings");
    expect(r.INVITE_ACCEPT).toBe("/app/invites/:token");
    expect(r.NOTES).toBe("/app/notes");
  });

  it("admin routes are rooted at /app/admin", () => {
    expect(r.ADMIN).toBe("/app/admin");
    expect(r.ADMIN_USERS).toBe("/app/admin/users");
    expect(r.ADMIN_EXECUTIONS).toBe("/app/admin/executions");
    expect(r.ADMIN_WORKFLOWS).toBe("/app/admin/workflows");
    expect(r.ADMIN_ANALYTICS).toBe("/app/admin/analytics");
  });
});
