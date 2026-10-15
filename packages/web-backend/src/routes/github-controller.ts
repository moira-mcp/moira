import { Router, json, type Request, type Response } from "express";
import { z } from "zod";
import {
  CodespaceResourceError,
  ScopedCredentialError,
  LocalDeviceError,
  providerFailureSchema,
  type LocalDeviceService,
} from "@mcp-moira/shared";
import {
  getCodespaceResourceService,
  getLocalDeviceService,
} from "../services/codespace-services.js";
import type { GitHubResourceService } from "../services/github-resource-service.js";
import { GitHubCodespaceClientError } from "../services/github-codespace-client.js";

/** Private fixed controller/renewal routes never enter global secret or body logging. */
export function createGitHubControllerRoutes(
  service: GitHubResourceService | null = getCodespaceResourceService(),
  devices: Pick<LocalDeviceService, "authenticateDevice"> = getLocalDeviceService(),
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  router.use(json());
  const endpoint =
    (
      handler: (
        req: Request,
        res: Response,
        bearer: string,
        id: string,
        resource: GitHubResourceService,
      ) => Promise<void>,
    ) =>
    (req: Request, res: Response) => {
      void Promise.resolve()
        .then(async () => {
          const bearer = req.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1],
            id = z.string().uuid().parse(req.params.resourceId);
          if (!bearer)
            throw new CodespaceResourceError(
              "CODESPACE_AUTHORIZATION_REQUIRED",
              "Controller authority refused",
            );
          if (!service)
            throw new CodespaceResourceError(
              "CODESPACE_PROVIDER_UNAVAILABLE",
              "Provider configuration unavailable",
            );
          await handler(req, res, bearer, id, service);
        })
        .catch((error: unknown) => {
          const providerFailure = providerFailureSchema.safeParse(
            error instanceof GitHubCodespaceClientError || error instanceof CodespaceResourceError
              ? error.providerFailure
              : undefined,
          );
          if (error instanceof ScopedCredentialError) {
            res.status(error.status).json({ error: { code: error.code, message: error.message } });
            return;
          }
          const controlled =
            error instanceof CodespaceResourceError
              ? error
              : error instanceof LocalDeviceError && error.code !== "LOCAL_OUTCOME_UNCONFIRMED"
                ? new CodespaceResourceError(
                    "CODESPACE_AUTHORIZATION_REQUIRED",
                    "Controller authority refused",
                  )
                : new CodespaceResourceError(
                    error instanceof z.ZodError
                      ? "CODESPACE_RESOURCE_INVALID"
                      : "WORKSPACE_OUTCOME_UNCONFIRMED",
                    error instanceof z.ZodError
                      ? "Controller request refused"
                      : "Collect the original owner request before repeating a mutation",
                  );
          const status =
            controlled.code === "CODESPACE_AUTHORIZATION_REQUIRED"
              ? 403
              : controlled.code === "CODESPACE_RESOURCE_INVALID"
                ? 400
                : controlled.code === "CODESPACE_GENERATION_CONFLICT"
                  ? 409
                  : 503;
          res.status(status).json({
            error: {
              code: controlled.code,
              message: controlled.message,
              ...(providerFailure.success ? { providerFailure: providerFailure.data } : {}),
            },
          });
        });
    };
  const auth = (bearer: string) => devices.authenticateDevice(bearer);
  router.get(
    "/:resourceId/assignment",
    endpoint(async (req, res, bearer, id, resource) => {
      const purpose = z.enum(["adopt", "retire"]).optional().parse(req.query.purpose);
      res.json(await resource.assignment(auth(bearer), id, purpose));
    }),
  );
  router.post(
    "/:resourceId/register",
    endpoint(async (req, res, bearer, id, resource) => {
      res.json(await resource.advanceAuthority(auth(bearer), id, req.body));
    }),
  );
  router.post(
    "/:resourceId/provider",
    endpoint(async (req, res, bearer, id, resource) => {
      res.json((await resource.providerAction(auth(bearer), id, req.body)) ?? null);
    }),
  );
  router.post(
    "/:resourceId/enroll",
    endpoint(async (req, res, bearer, id, resource) => {
      res.json(await resource.enroll(auth(bearer), id, req.body));
    }),
  );
  router.post(
    "/:resourceId/renew-enrollment",
    endpoint(async (req, res, bearer, id, resource) => {
      res.json(await resource.renew(id, bearer, req.body));
    }),
  );
  router.use((_error: unknown, _req: Request, res: Response, _next: unknown) => {
    res.status(400).json({
      error: { code: "CODESPACE_RESOURCE_INVALID", message: "Controller request refused" },
    });
  });
  return router;
}
