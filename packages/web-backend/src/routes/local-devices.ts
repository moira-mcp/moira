import { Router, json, type Request, type Response, type NextFunction } from "express";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  LocalDeviceError,
  localPublicPolicySchema,
  localAcknowledgementSchema,
  localControlReportSchema,
  localControlRequestSchema,
  type LocalDeviceService,
  type LocalDeviceAuth,
  type LocalRelayAcknowledgement,
} from "@mcp-moira/shared";
import type { AuthenticatedRequest } from "../types/express-types.js";
import { getLocalRepositoryAdmissionService } from "../services/local-repository-admission-factory.js";
import { issueWorkspaceAgentCredential } from "../services/workspace-services.js";
import { getSqliteInstance } from "@mcp-moira/shared";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;
function endpoint(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => {
        if (error instanceof LocalDeviceError) {
          const status = {
            LOCAL_UNAUTHORIZED: 401,
            LOCAL_CONFLICT: 409,
            LOCAL_EXPIRED: 410,
            LOCAL_INVALID: 400,
          }[error.code];
          res
            .status(status)
            .json({ success: false, error: { code: error.code, message: error.message } });
          return;
        }
        if (error instanceof z.ZodError) {
          res.status(400).json({
            success: false,
            error: { code: "LOCAL_INVALID", message: "Invalid local-device request." },
          });
          return;
        }
        next(error);
      });
  };
}
function protectOrigin(router: Router, publicOrigin: string): void {
  const expected = new URL(publicOrigin).origin;
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const origin = req.get("Origin");
    if (origin !== undefined && origin !== expected) {
      res
        .status(403)
        .json({ success: false, error: { code: "LOCAL_UNAUTHORIZED", message: "Origin denied." } });
      return;
    }
    next();
  });
}
function deviceAuth(service: LocalDeviceService, req: Request): LocalDeviceAuth {
  const bearer = req.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!bearer) throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Device access denied.");
  return service.authenticateDevice(bearer);
}
function claimHeader(req: Request): string {
  return z.string().uuid().parse(req.get("X-Moira-Claim-Id"));
}
function param(req: Request, key: string): string {
  return z.string().uuid().parse(req.params[key]);
}
/** Parser errors can carry their input in error.body; never forward them to global logging. */
function finishRouter(router: Router): Router {
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const parser =
      error !== null && typeof error === "object"
        ? (error as { type?: unknown; body?: unknown })
        : null;
    const types = new Set([
      "entity.parse.failed",
      "entity.too.large",
      "request.aborted",
      "request.size.invalid",
      "encoding.unsupported",
      "charset.unsupported",
      "stream.encoding.set",
      "stream.not.readable",
    ]);
    if (
      parser &&
      (Object.prototype.hasOwnProperty.call(parser, "body") ||
        (typeof parser.type === "string" && types.has(parser.type)))
    ) {
      res.status(parser.type === "entity.too.large" ? 413 : 400).json({
        success: false,
        error: { code: "LOCAL_INVALID", message: "Invalid local-device request." },
      });
      return;
    }
    next(error);
  });
  return router;
}

/** Mount with ordinary admitted-user authentication at /api/integrations/local. */
export function createLocalDeviceManagementRoutes(
  service: LocalDeviceService,
  publicOrigin: string,
): Router {
  const router = Router();
  protectOrigin(router, publicOrigin);
  router.use(json({ limit: "2mb" }));
  const owner = (req: Request) => {
    const id = (req as AuthenticatedRequest).userId;
    if (typeof id !== "string" || !id)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Account access is required.");
    return id;
  };
  router.get(
    "/devices",
    endpoint((req, res) => res.json({ success: true, data: service.listOwned(owner(req)) })),
  );
  router.post(
    "/pairings",
    endpoint((req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      res.status(201).json({ success: true, data: service.beginEnrollment(owner(req)) });
    }),
  );
  router.post(
    "/pairings/:id/confirm",
    endpoint((req, res) => {
      const input = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(req.body);
      res.json({
        success: true,
        data: service.confirmEnrollment(owner(req), param(req, "id"), input.expectedRevision),
      });
    }),
  );
  router.delete(
    "/devices/:id",
    endpoint((req, res) => {
      const input = z
        .object({ expectedGeneration: z.number().int().positive() })
        .strict()
        .parse(req.body);
      res.json({
        success: true,
        data: service.revokeOwned(owner(req), param(req, "id"), input.expectedGeneration),
      });
    }),
  );
  router.put(
    "/devices/:id/settings",
    endpoint(async (req, res) => {
      if (
        !(req as AuthenticatedRequest).session?.token ||
        req.get("Authorization") ||
        req.get("Origin") !== new URL(publicOrigin).origin
      )
        throw new LocalDeviceError(
          "LOCAL_UNAUTHORIZED",
          "A confirmed browser session and matching origin are required.",
        );
      const input = localControlRequestSchema.parse(req.body);
      if (input.settings.agentRepositoryManagement)
        await getLocalRepositoryAdmissionService().validateOwner(
          owner(req),
          input.settings.agentRepositoryManagement,
        );
      res.json({
        success: true,
        data: service.requestSettings(owner(req), param(req, "id"), input),
      });
    }),
  );
  return finishRouter(router);
}

/** Native companion initiates outbound requests; these routes use device credentials, not cookies. */
export function createLocalDeviceRoutes(service: LocalDeviceService, publicOrigin: string): Router {
  const router = Router();
  protectOrigin(router, publicOrigin);
  router.use(json({ limit: "2mb" }));
  router.post(
    "/workspaces/bootstrap",
    endpoint((req, res) => {
      const auth = deviceAuth(service, req);
      const input = z
        .object({
          resourceId: z.string().uuid(),
          environmentIdentity: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(req.body);
      const binding = getSqliteInstance()
        .prepare(
          `SELECT 1 FROM codespaceLocalResourceBinding
        WHERE resourceId=? AND userId=? AND deviceId=? AND deviceGeneration=?`,
        )
        .get(input.resourceId, auth.userId, auth.deviceId, auth.deviceGeneration);
      if (!binding) throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Workspace binding refused.");
      res.json({
        success: true,
        data: issueWorkspaceAgentCredential(
          auth.userId,
          input.resourceId,
          input.environmentIdentity,
        ),
      });
    }),
  );
  router.post(
    "/enroll",
    endpoint((req, res) =>
      res.status(201).json({ success: true, data: service.approveLocalEnrollment(req.body) }),
    ),
  );
  router.post(
    "/pairings/status",
    endpoint((req, res) => res.json({ success: true, data: service.pairingStatus(req.body) })),
  );
  router.post(
    "/heartbeat",
    endpoint((req, res) => {
      const auth = deviceAuth(service, req),
        input = z
          .object({ policy: localPublicPolicySchema, control: localControlReportSchema.optional() })
          .strict()
          .parse(req.body);
      res.json({ success: true, data: service.heartbeat(auth, input.policy, input.control) });
    }),
  );
  router.post(
    "/relay/claim",
    endpoint(async (req, res) => {
      const input = z
        .object({
          limit: z.number().int().min(1).max(8).default(1),
          waitMs: z.number().int().min(0).max(25000).default(0),
        })
        .strict()
        .parse(req.body ?? {});
      const aborted = new AbortController();
      const close = () => aborted.abort();
      res.once("close", close);
      const deadline = Date.now() + input.waitMs;
      try {
        while (!aborted.signal.aborted) {
          const requests = service.claim(deviceAuth(service, req), input.limit);
          if (requests.length || Date.now() >= deadline) {
            res.json({
              success: true,
              data: { requests },
            });
            return;
          }
          try {
            await delay(Math.min(1000, deadline - Date.now()), undefined, {
              signal: aborted.signal,
            });
          } catch (error) {
            if (!aborted.signal.aborted) throw error;
          }
        }
      } finally {
        res.off("close", close);
      }
    }),
  );
  router.post(
    "/relay/:requestId/renew",
    endpoint((req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      res.json({
        success: true,
        data: service.renewClaim(
          deviceAuth(service, req),
          param(req, "requestId"),
          claimHeader(req),
        ),
      });
    }),
  );
  router.post(
    "/relay/ack",
    endpoint(async (req, res) => {
      const auth = deviceAuth(service, req),
        ack = localAcknowledgementSchema.parse(req.body) as LocalRelayAcknowledgement;
      const existing = service.getResult(auth.userId, ack.requestId);
      if (existing?.status === "completed" || existing?.status === "refused") {
        res.json({ success: true, data: service.acknowledge(auth, ack) });
        return;
      }
      res.json({ success: true, data: service.acknowledge(deviceAuth(service, req), ack) });
    }),
  );
  return finishRouter(router);
}
