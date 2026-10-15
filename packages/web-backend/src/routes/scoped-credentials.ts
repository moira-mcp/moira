import { Router, json, type Request, type Response } from "express";
import { z } from "zod";
import {
  ScopedCredentialError,
  scopedCredentialAcquireSchema,
  scopedCredentialReleaseSchema,
} from "@mcp-moira/shared";
import type { ScopedCredentialService } from "../services/scoped-credential-service.js";

/** This private route handles secrets directly and never forwards raw failures to global logging. */
export function createScopedCredentialRouter(
  service: Pick<ScopedCredentialService, "acquire" | "release" | "collect">,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  router.use(json());
  const endpoint =
    (handler: (req: Request, res: Response, bearer: string) => Promise<void>) =>
    (req: Request, res: Response) => {
      void Promise.resolve()
        .then(async () => {
          const authorization = req.get("Authorization"),
            match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
          if (!match) throw new ScopedCredentialError("SCOPED_CREDENTIAL_AUTHORITY_REFUSED", 401);
          await handler(req, res, match[1]!);
        })
        .catch((error: unknown) => {
          const controlled =
            error instanceof ScopedCredentialError
              ? error
              : new ScopedCredentialError(
                  error instanceof z.ZodError
                    ? "SCOPED_CREDENTIAL_INVALID"
                    : "SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED",
                  error instanceof z.ZodError ? 400 : 503,
                );
          res.status(controlled.status).json({
            error: {
              code: controlled.code,
              message: controlled.message,
            },
          });
        });
    };
  router.post(
    "/requests/:requestId",
    endpoint(async (req, res, bearer) => {
      const input = scopedCredentialAcquireSchema.parse(req.body);
      if (input.requestId !== req.params.requestId)
        throw new ScopedCredentialError("SCOPED_CREDENTIAL_CONFLICT");
      res.json(await service.collect(bearer, input));
    }),
  );
  router.post(
    "/acquire",
    endpoint(async (req, res, bearer) => {
      res.json(await service.acquire(bearer, scopedCredentialAcquireSchema.parse(req.body)));
    }),
  );
  router.post(
    "/:credentialId/release",
    endpoint(async (req, res, bearer) => {
      const credentialId = z.string().uuid().parse(req.params.credentialId);
      await service.release(bearer, credentialId, scopedCredentialReleaseSchema.parse(req.body));
      res.json({ released: true });
    }),
  );
  router.use((_error: unknown, _req: Request, res: Response, _next: unknown) => {
    res.status(400).json({
      error: {
        code: "SCOPED_CREDENTIAL_INVALID",
        message: "Scoped credential operation refused",
      },
    });
  });
  return router;
}
