import { Router } from "express";
import { z } from "zod";
import { LocalDeviceError, type LocalDeviceService } from "@mcp-moira/shared";
import type { LocalGitIdentity } from "../services/local-git-identity.js";

export function createLocalGitIdentityRoutes(
  devices: LocalDeviceService,
  identity: LocalGitIdentity,
  publicOrigin: string,
): Router {
  const router = Router();
  const expectedOrigin = new URL(publicOrigin).origin;
  router.get("/github/:resourceId/:resourceGeneration/identity", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    void (async () => {
      if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin)
        throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Origin denied.");
      const token = req.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!token) throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
      const auth = devices.authenticateDevice(token);
      const id = z.string().uuid().parse(req.params.resourceId);
      const generation = z.coerce.number().int().positive().parse(req.params.resourceGeneration);
      res.json({ success: true, data: await identity.identity(auth, id, generation) });
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof LocalDeviceError) {
        res
          .status(403)
          .json({ success: false, error: { code: error.code, message: error.message } });
      } else {
        res.status(error instanceof z.ZodError ? 400 : 503).json({
          success: false,
          error: {
            code: error instanceof z.ZodError ? "LOCAL_INVALID" : "LOCAL_UNAVAILABLE",
            message: "Verified Git author metadata is unavailable.",
          },
        });
      }
    });
  });
  return router;
}
