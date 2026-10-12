import express, { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  CodespaceResourceError,
  type CodespaceFileTransferService,
  isTestEnvironment,
  isRateLimitDisabled,
  getRateLimitWhitelist,
} from "@mcp-moira/shared";
import { getCodespaceProviderServices } from "../services/codespace-services.js";
import { createCodespaceFileCapabilities } from "../services/codespace-file-transfers.js";
import { createCodespaceFileRateLimiter } from "../middleware/rate-limit-middleware.js";

const id = z.string().uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mint = z.discriminatedUnion("direction", [
  z
    .object({
      direction: z.literal("guest_to_server"),
      requestId: id,
      size: integer,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      fileName: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(255),
    })
    .strict(),
  z
    .object({
      direction: z.literal("server_to_guest"),
      requestId: id,
      referenceId: z.string().regex(/^codespace-file:\/\/[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
]);

/** Mount before general JSON parsing and request-body logging: binary chunks stay bounded and private. */
export function createCodespaceFileRoutes(
  resolve: (token: string) => CodespaceFileTransferService = (token) => {
    const claims = createCodespaceFileCapabilities().read(token);
    const service = getCodespaceProviderServices(claims.provider).fileTransfers;
    if (!service)
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "File provider is unavailable",
      );
    return service;
  },
): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  const token = (request: Request): string => {
    const match = /^Bearer (csf1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})$/.exec(
      request.get("authorization") ?? "",
    );
    if (!match)
      throw new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "A file capability is required",
      );
    return match[1];
  };
  const handle =
    (action: (request: Request, response: Response) => Promise<void>) =>
    (request: Request, response: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => action(request, response))
        .catch(next);
    };
  router.use(
    createCodespaceFileRateLimiter({
      skipLimits: isTestEnvironment() || isRateLimitDisabled(),
      whitelist: getRateLimitWhitelist(),
      authenticate: async (request) => {
        const credential = token(request);
        return resolve(credential).requestRateScope(credential, request.method, request.path);
      },
    }),
  );
  const json = express.json({ limit: 8192, strict: true });
  router.post(
    "/transfers",
    json,
    handle(async (request, response) => {
      const credential = token(request);
      response.json(await resolve(credential).mint(credential, mint.parse(request.body)));
    }),
  );
  router.post(
    "/lookup",
    json,
    handle(async (request, response) => {
      const credential = token(request);
      response.json(
        await resolve(credential).lookup(
          credential,
          z.object({ requestId: id }).strict().parse(request.body).requestId,
        ),
      );
    }),
  );
  router.get(
    "/transfers/:id",
    handle(async (request, response) => {
      const credential = token(request);
      response.json(
        await resolve(credential).transferStatus(credential, id.parse(request.params.id)),
      );
    }),
  );
  router.get(
    "/transfers/:id/chunks",
    handle(async (request, response) => {
      const credential = token(request);
      const query = z
        .object({
          offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          length: z.coerce.number().int().positive().max(262144),
        })
        .strict()
        .parse(request.query);
      const result = await resolve(credential).readChunk(
        credential,
        id.parse(request.params.id),
        query,
      );
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("X-Chunk-SHA256", result.sha256);
      response.setHeader("X-Chunk-Offset", String(query.offset));
      response.send(result.bytes);
    }),
  );
  router.put(
    "/transfers/:id/chunks",
    express.raw({ type: "application/octet-stream", limit: 262144 }),
    handle(async (request, response) => {
      const credential = token(request);
      const offset = z.coerce
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .parse(request.query.offset);
      const sha256 = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(request.get("X-Chunk-SHA256"));
      if (!Buffer.isBuffer(request.body))
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "A binary chunk is required",
        );
      response.json(
        await resolve(credential).writeChunk(credential, id.parse(request.params.id), {
          offset,
          sha256,
          bytes: request.body,
        }),
      );
    }),
  );
  router.post(
    "/transfers/:id/finalize",
    handle(async (request, response) => {
      const credential = token(request);
      if (
        (request.get("content-length") && request.get("content-length") !== "0") ||
        request.get("transfer-encoding")
      )
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Finalization has no request body",
        );
      response.json(await resolve(credential).finalize(credential, id.parse(request.params.id)));
    }),
  );
  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof CodespaceResourceError) {
      const status =
        error.code === "CODESPACE_NOT_FOUND"
          ? 404
          : error.code === "CODESPACE_AUTHORIZATION_REQUIRED"
            ? 403
            : error.code === "CODESPACE_RESULT_EXPIRED"
              ? 410
              : 409;
      response.status(status).json({ error: { code: error.code, message: error.message } });
    } else if (
      error instanceof z.ZodError ||
      (error &&
        typeof error === "object" &&
        "status" in error &&
        [400, 413].includes(Number(error.status)))
    )
      response.status(400).json({
        error: { code: "CODESPACE_RESOURCE_INVALID", message: "Invalid file transfer request" },
      });
    else
      response.status(503).json({
        error: {
          code: "CODESPACE_PROVIDER_UNAVAILABLE",
          message: "File transfer outcome is unconfirmed",
        },
      });
  });
  return router;
}
