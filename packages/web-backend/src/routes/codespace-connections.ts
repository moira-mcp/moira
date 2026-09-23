import { Router } from "express";
import {
  CodespaceConnectionError,
  codespaceGitHubSettingsPath,
  type CodespaceConnectionService,
  type CodespaceConnectionView,
} from "@mcp-moira/shared";
import type { AuthenticatedRequest } from "../types/express-types.js";
import { asyncHandler } from "../middleware/error-middleware.js";
import { getCodespaceConnectionService } from "../services/codespace-connection-service.js";

/** The Settings URL, absolute or a path on this site, carrying an outcome the page explains. */
function redirectWithOutcome(settingsUrl: string, outcome: string): string {
  const relative = settingsUrl.startsWith("/");
  const url = new URL(settingsUrl, relative ? "http://this-site.invalid" : undefined);
  url.searchParams.set("github", outcome);
  return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

/**
 * The authorization start on the configured site, absolute like the Settings URL it is derived from.
 * The API is served at the site root in every deployment mode (only the web UI moves under the app
 * prefix), so the path is taken from the root of that URL.
 */
function startUrl(settingsUrl: string): string {
  return new URL("/api/integrations/github/start", settingsUrl).toString();
}

/**
 * Why a browser's authorization start was refused, as a Settings outcome the page explains. A
 * browser navigation must land on a page, never on a JSON error.
 */
function startRefusalOutcome(
  error: CodespaceConnectionError,
  state: CodespaceConnectionView["state"],
): string {
  if (state === "connected") return "already_connected";
  if (state === "revocation_pending") return "revocation_pending";
  switch (error.code) {
    case "CODESPACE_NOT_CONFIGURED":
      return "not_configured";
    case "CREDENTIAL_UNREADABLE":
      return "credential_unreadable";
    case "AUTH_GRANT_REVOCATION_REQUIRED":
      return "grant_revocation_required";
    case "AUTH_REFRESH_FAILED":
      return "previous_access_not_revoked";
    default:
      return "authorization_failed";
  }
}

export function createCodespaceConnectionRoutes(
  service: CodespaceConnectionService = getCodespaceConnectionService(),
): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  router.get(
    "/github",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      const refresh = await service.refreshGrants(userId);
      res.json({
        success: true,
        data: { ...service.getStatus(userId), repositoriesStale: refresh.stale },
      });
    }),
  );

  router.post(
    "/github/refresh",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      const refresh = await service.refreshGrants(userId, { force: true });
      res.json({
        success: true,
        data: { ...service.getStatus(userId), repositoriesStale: refresh.stale },
      });
    }),
  );

  router.get(
    "/github/start",
    asyncHandler(async (req, res) => {
      const authenticated = req as AuthenticatedRequest;
      if (!authenticated.session?.token) {
        res.redirect(
          303,
          redirectWithOutcome(
            service.getStatus(authenticated.userId).settingsUrl,
            "session_required",
          ),
        );
        return;
      }
      try {
        const authorizationUrl = await service.beginAuthorization(
          authenticated.userId,
          authenticated.session.token,
        );
        res.redirect(303, authorizationUrl);
      } catch (error) {
        if (error instanceof CodespaceConnectionError) {
          const status = service.getStatus(authenticated.userId);
          res.redirect(
            303,
            redirectWithOutcome(status.settingsUrl, startRefusalOutcome(error, status.state)),
          );
          return;
        }
        throw error;
      }
    }),
  );

  router.get("/github/callback", async (req, res) => {
    const authenticated = req as AuthenticatedRequest;
    let settingsUrl: string | null = null;
    try {
      settingsUrl = service.getStatus(authenticated.userId).settingsUrl;
      if (!authenticated.session?.token) {
        res.redirect(303, redirectWithOutcome(settingsUrl, "authorization_failed"));
        return;
      }
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      // GitHub sends the browser back here after the user installs or updates the App
      // (setup_action / installation_id) without Moira's one-time state. Nothing from that return
      // is trusted — its code is never exchanged. The stored credential reads the installations
      // afresh; only without one does the browser start an authorization.
      if (
        !state &&
        (req.query.installation_id !== undefined || req.query.setup_action !== undefined)
      ) {
        const outcome = await service.completeInstallationReturn(authenticated.userId);
        res.redirect(
          303,
          outcome === "authorization_required"
            ? startUrl(settingsUrl)
            : redirectWithOutcome(settingsUrl, outcome),
        );
        return;
      }
      const status = await service.completeAuthorization({
        userId: authenticated.userId,
        sessionToken: authenticated.session.token,
        state,
        code,
      });
      // Authorized but the App is not installed yet: continue straight to GitHub's install page,
      // whose return comes back here and finishes with the credential just stored.
      if (status.state === "installation_required" && status.installationUrl) {
        res.redirect(303, status.installationUrl);
        return;
      }
      res.redirect(
        303,
        redirectWithOutcome(
          settingsUrl,
          status.state === "connected" ? "connected" : "installation_required",
        ),
      );
    } catch {
      // GitHub code and state must never enter the shared error/logging projection.
      // A browser navigation lands on a page, never on JSON: when not even the status could be
      // read, the Settings path on this site needs nothing but the app prefix.
      res.redirect(
        303,
        redirectWithOutcome(settingsUrl ?? codespaceGitHubSettingsPath(), "authorization_failed"),
      );
    }
  });

  router.delete(
    "/github/external-revocation",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      try {
        const status = await service.confirmExternalRevocation(
          userId,
          req.body?.confirmed === true,
        );
        res.json({ success: true, data: status });
      } catch (error) {
        if (error instanceof CodespaceConnectionError) {
          res.status(error.code === "CREDENTIAL_UNREADABLE" ? 409 : 400).json({
            success: false,
            error: { code: error.code, message: error.message },
            settings_url: service.getStatus(userId).settingsUrl,
          });
          return;
        }
        throw error;
      }
    }),
  );

  router.delete(
    "/github",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      try {
        const status = await service.disconnect(userId);
        res.json({ success: true, data: status });
      } catch (error) {
        if (error instanceof CodespaceConnectionError) {
          res.status(503).json({
            success: false,
            error: { code: error.code, message: error.message },
            settings_url: service.getStatus(userId).settingsUrl,
          });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
