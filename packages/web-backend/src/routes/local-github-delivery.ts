import { Router, json, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { LocalDeviceError, type LocalDeviceService } from "@mcp-moira/shared";
import { gitDeliveryActionSchema, LocalGitHubDelivery } from "../services/local-github-delivery.js";

/** Device-only fixed repository actions, mounted before global body parsing or logging. */
export function createLocalGitHubDeliveryRoutes(
  devices: LocalDeviceService,
  delivery: LocalGitHubDelivery,
  publicOrigin: string,
): Router {
  const router = Router();
  const expectedOrigin = new URL(publicOrigin).origin;
  const scope = (request: Request) => {
    if (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Origin denied.");
    const token = request.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
    return {
      auth: devices.authenticateDevice(token),
      id: z.string().uuid().parse(request.params.resourceId),
      generation: z.coerce.number().int().positive().parse(request.params.resourceGeneration),
    };
  };
  const endpoint =
    (handler: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      res.setHeader("Cache-Control", "no-store");
      void handler(req, res).catch((error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof LocalDeviceError) {
          res
            .status(
              error.code === "LOCAL_INVALID"
                ? 400
                : error.code === "LOCAL_CONFLICT"
                  ? 409
                  : error.code === "LOCAL_EXPIRED"
                    ? 410
                    : 403,
            )
            .json({ success: false, error: { code: error.code, message: error.message } });
          return;
        }
        if (error instanceof z.ZodError) {
          res.status(400).json({
            success: false,
            error: { code: "LOCAL_INVALID", message: "Invalid GitHub repository action." },
          });
          return;
        }
        next(error);
      });
    };
  const prefix = "/github/:resourceId/:resourceGeneration";
  router.get(
    `${prefix}/identity`,
    endpoint(async (req, res) => {
      const { auth, id, generation } = scope(req);
      res.json({ success: true, data: await delivery.identity(auth, id, generation) });
    }),
  );
  router.all(
    `${prefix}/git/:action`,
    endpoint(async (req, res) => {
      const { auth, id, generation } = scope(req);
      if (Object.keys(req.query).length)
        throw new LocalDeviceError("LOCAL_INVALID", "Git action does not accept query parameters.");
      await delivery.git(
        auth,
        id,
        generation,
        gitDeliveryActionSchema.parse(req.params.action),
        req,
        res,
      );
    }),
  );
  router.post(
    `${prefix}/pulls`,
    json({ limit: "128kb" }),
    endpoint(async (req, res) => {
      const { auth, id, generation } = scope(req);
      res.status(201).json({
        success: true,
        data: await delivery.createPullRequest(auth, id, generation, req.body),
      });
    }),
  );
  router.get(
    `${prefix}/pulls/:number`,
    endpoint(async (req, res) => {
      const { auth, id, generation } = scope(req);
      res.json({
        success: true,
        data: await delivery.getPullRequest(
          auth,
          id,
          generation,
          z.coerce.number().int().positive().parse(req.params.number),
        ),
      });
    }),
  );
  router.post(
    `${prefix}/pulls/find`,
    json({ limit: "8kb" }),
    endpoint(async (req, res) => {
      const { auth, id, generation } = scope(req);
      res.json({
        success: true,
        data: await delivery.findPullRequests(auth, id, generation, req.body),
      });
    }),
  );
  // JSON parser failures may contain secrets in error.body; keep them out of global logs.
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error && typeof error === "object" && ("body" in error || "type" in error)) {
      res.status(400).json({
        success: false,
        error: { code: "LOCAL_INVALID", message: "Invalid GitHub repository action." },
      });
      return;
    }
    next(error);
  });
  return router;
}
