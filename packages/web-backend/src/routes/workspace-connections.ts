import { Router } from "express";
import { WorkspaceConnectionError, type WorkspaceConnectionService } from "@mcp-moira/shared";
import type { AuthenticatedRequest } from "../types/express-types.js";
import { asyncHandler } from "../middleware/error-middleware.js";
import { getWorkspaceConnectionService } from "../services/workspace-connection-service.js";

function redirectWithOutcome(settingsUrl: string, outcome: string): string {
  const url = new URL(settingsUrl);
  url.searchParams.set("github", outcome);
  return url.toString();
}

export function createWorkspaceConnectionRoutes(
  service: WorkspaceConnectionService = getWorkspaceConnectionService(),
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
      res.json({ success: true, data: service.getStatus(userId) });
    }),
  );

  router.get(
    "/github/start",
    asyncHandler(async (req, res) => {
      const authenticated = req as AuthenticatedRequest;
      if (!authenticated.session?.token) {
        res.status(401).json({
          success: false,
          error: { code: "AUTHENTICATION_REQUIRED", message: "A current web session is required" },
        });
        return;
      }
      try {
        const authorizationUrl = await service.beginAuthorization(
          authenticated.userId,
          authenticated.session.token,
        );
        res.redirect(303, authorizationUrl);
      } catch (error) {
        if (error instanceof WorkspaceConnectionError) {
          res.status(503).json({
            success: false,
            error: { code: error.code, message: error.message },
            settings_url: service.getStatus(authenticated.userId).settingsUrl,
          });
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
      // GitHub sends the browser back here after the user installs the App (setup_action /
      // installation_id) without Moira's one-time state. Nothing from that return is trusted:
      // a fresh authorization is started, and its callback re-reads the installations.
      if (
        !state &&
        (req.query.installation_id !== undefined || req.query.setup_action !== undefined)
      ) {
        res.redirect(303, "/api/integrations/github/start");
        return;
      }
      const status = await service.completeAuthorization({
        userId: authenticated.userId,
        sessionToken: authenticated.session.token,
        state,
        code,
      });
      res.redirect(
        303,
        redirectWithOutcome(
          settingsUrl,
          status.state === "connected" ? "connected" : "installation_required",
        ),
      );
    } catch {
      // GitHub code and state must never enter the shared error/logging projection.
      if (settingsUrl) {
        res.redirect(303, redirectWithOutcome(settingsUrl, "authorization_failed"));
        return;
      }
      res.status(400).json({
        success: false,
        error: { code: "AUTHORIZATION_FAILED", message: "GitHub authorization failed" },
      });
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
        if (error instanceof WorkspaceConnectionError) {
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
        if (error instanceof WorkspaceConnectionError) {
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
