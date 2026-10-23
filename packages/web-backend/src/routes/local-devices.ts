import {
  Router,
  json,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { z } from "zod";
import {
  LocalDeviceError,
  localControlRequestSchema,
  type LocalDeviceService,
  type LocalDeviceAuth,
  controllerResourceRegistrationSchema,
  CODESPACE_PROVIDER_LOCAL,
  type ControllerResourceRegistration,
  CodespaceResourceError,
  ScopedCredentialError,
} from "@mcp-moira/shared";
import type { AuthenticatedRequest } from "../types/express-types.js";
import { getLocalRepositoryAdmissionService } from "../services/local-repository-admission-factory.js";
import { issueWorkspaceAgentCredential } from "../services/workspace-services.js";
import { getSqliteInstance } from "@mcp-moira/shared";
import { getCodespaceProviderServices } from "../services/codespace-services.js";
import { LocalCodespaceResourceService } from "../services/local-codespace-resource-service.js";
import { readOwnerJsonBody } from "@mcp-moira/shared/http/request-body";
import { settleOwnerFrame } from "@mcp-moira/shared/http/owner-stream-frame";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;
function endpoint(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => {
        if (error instanceof ScopedCredentialError) {
          res.status(error.status).json({
            success: false,
            error: {
              code: error.code,
              message: "Owner access was retired; scoped credential disposal remains pending.",
            },
          });
          return;
        }
        if (error instanceof LocalDeviceError) {
          const status = {
            LOCAL_UNAUTHORIZED: 401,
            LOCAL_CONFLICT: 409,
            LOCAL_EXPIRED: 410,
            LOCAL_INVALID: 400,
            LOCAL_UNAVAILABLE: 503,
            LOCAL_OUTCOME_UNCONFIRMED: 409,
          }[error.code];
          res.status(status).json({
            success: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.requestId ? { request_id: error.requestId } : {}),
            },
          });
          return;
        }
        if (error instanceof CodespaceResourceError) {
          const status =
            error.code === "CODESPACE_GENERATION_CONFLICT"
              ? 409
              : error.code === "CODESPACE_RESOURCE_INVALID"
                ? 400
                : error.code === "CODESPACE_PROVIDER_UNAVAILABLE"
                  ? 503
                  : 403;
          res.status(status).json({
            success: false,
            error: {
              code: error.code,
              message: "Resource registration was refused before any native work.",
            },
          });
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
  revalidate: RequestHandler,
): Router {
  const router = Router();
  protectOrigin(router, publicOrigin);
  const owner = (req: Request) => {
    const id = (req as AuthenticatedRequest).userId;
    if (typeof id !== "string" || !id)
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Account access is required.");
    return id;
  };
  router.get(
    "/devices",
    endpoint(async (req, res) =>
      res.json({ success: true, data: await service.listOwned(owner(req)) }),
    ),
  );
  router.post(
    "/pairings",
    json({ limit: "2mb" }),
    endpoint((req, res) => {
      z.object({})
        .strict()
        .parse(req.body ?? {});
      res.status(201).json({ success: true, data: service.beginEnrollment(owner(req)) });
    }),
  );
  router.post(
    "/pairings/:id/confirm",
    json({ limit: "2mb" }),
    endpoint(async (req, res) => {
      const input = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(req.body);
      res.json({
        success: true,
        data: await service.confirmEnrollment(owner(req), param(req, "id"), input.expectedRevision),
      });
    }),
  );
  router.delete(
    "/devices/:id",
    json({ limit: "2mb" }),
    endpoint(async (req, res) => {
      const input = z
        .object({ expectedGeneration: z.number().int().positive() })
        .strict()
        .parse(req.body);
      res.json({
        success: true,
        data: await service.revokeOwned(owner(req), param(req, "id"), input.expectedGeneration),
      });
    }),
  );
  router.put(
    "/devices/:id/settings",
    endpoint(async (req, res, next) => {
      try {
        res.locals.localSettingsOwner = owner(req);
        if (
          !(req as AuthenticatedRequest).session?.token ||
          req.get("Authorization") ||
          req.get("Origin") !== new URL(publicOrigin).origin
        )
          throw new LocalDeviceError(
            "LOCAL_UNAUTHORIZED",
            "A confirmed browser session and matching origin are required.",
          );
        if (!req.is("application/json"))
          throw new LocalDeviceError("LOCAL_INVALID", "Invalid local-device request.");
        try {
          req.body = await readOwnerJsonBody(req);
        } catch {
          throw new LocalDeviceError("LOCAL_INVALID", "Invalid local-device request.");
        }
        next();
      } catch (error) {
        settleOwnerFrame(req, res);
        throw error;
      }
    }),
    revalidate,
    endpoint(async (req, res) => {
      if (owner(req) !== res.locals.localSettingsOwner)
        throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Account access changed during input.");
      const input = localControlRequestSchema.parse(req.body);
      if (input.settings.agentRepositoryManagement)
        await getLocalRepositoryAdmissionService().validateOwner(
          owner(req),
          input.settings.agentRepositoryManagement,
        );
      res.json({
        success: true,
        data: await service.requestSettings(owner(req), param(req, "id"), input),
      });
    }),
  );
  for (const path of [
    "/devices/:id/settings/operations/:requestId",
    "/devices/:id/operations/:requestId",
  ]) {
    router.get(
      path,
      endpoint(async (req, res) => {
        const requestId = z
          .string()
          .regex(/^ws1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
          .parse(req.params.requestId);
        const data = path.includes("/settings/")
          ? await service.collectSettings(owner(req), param(req, "id"), requestId)
          : await service.getOperation(owner(req), param(req, "id"), requestId);
        res.json({ success: true, data });
      }),
    );
  }
  return finishRouter(router);
}

/** Native companion initiates outbound requests; these routes use device credentials, not cookies. */
export function createLocalDeviceRoutes(
  service: LocalDeviceService,
  publicOrigin: string,
  registerResource: (
    auth: LocalDeviceAuth,
    input: ControllerResourceRegistration,
  ) => Promise<unknown> = async (auth, input) => {
    const resource = getCodespaceProviderServices(CODESPACE_PROVIDER_LOCAL).resource;
    if (!(resource instanceof LocalCodespaceResourceService))
      throw new LocalDeviceError("LOCAL_UNAVAILABLE", "The Local route authority is unavailable.");
    return resource.registerRoute(auth.userId, auth.deviceId, input);
  },
): Router {
  const router = Router();
  protectOrigin(router, publicOrigin);
  router.use(json({ limit: "2mb" }));
  router.post(
    "/resources/register",
    endpoint(async (req, res) => {
      const auth = deviceAuth(service, req),
        input = controllerResourceRegistrationSchema.parse(req.body);
      res.json({ success: true, data: await registerResource(auth, input) });
    }),
  );
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
        WHERE resourceId=? AND userId=? AND deviceId=? AND deviceGeneration=? AND revokedAt IS NULL`,
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
      z.object({})
        .strict()
        .parse(req.body ?? {});
      const auth = deviceAuth(service, req),
        current = service.getDeviceIdentity(auth.userId, auth.deviceId);
      res.json({ success: true, data: { ...current } });
    }),
  );
  return finishRouter(router);
}
