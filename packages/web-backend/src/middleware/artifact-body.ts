import express, { type Request, type Response, type RequestHandler } from "express";
import multer from "multer";
import { getArtifactJsonBodyLimit } from "@mcp-moira/shared/artifact-size-policy";
import { settleOwnerFrame } from "@mcp-moira/shared/http/owner-stream-frame";
import { asyncHandler, createApiError } from "./error-middleware.js";
import type { AuthenticatedRequest } from "../types/express-types.js";

// Busboy reports malformed multipart input without a structured HTTP error type.
const MALFORMED_MULTIPART_ERRORS = new Set([
  "Multipart: Boundary not found",
  "Malformed part header",
  "Unexpected end of form",
  "Unexpected end of file",
]);

/** Read only after the caller has established the session or upload-token owner. */
export async function readArtifactBody(
  req: Request,
  res: Response,
  maxContentBytes: number,
  allowMultipart = false,
): Promise<boolean> {
  const bodyLimitBytes = getArtifactJsonBodyLimit(maxContentBytes);
  try {
    if (allowMultipart && req.is("multipart/form-data")) {
      const upload = multer({
        storage: multer.memoryStorage(),
        limits: {
          fileSize: maxContentBytes,
          files: 1,
          fields: 2,
          parts: 3,
          fieldNameSize: 100,
          fieldSize: 16 * 1024,
        },
      }).single("file");
      await new Promise<void>((resolve, reject) => {
        upload(req, res, (error) => (error ? reject(error) : resolve()));
      });
    } else {
      if (!req.is("application/json"))
        throw createApiError.badRequest("Send application/json or an admitted multipart upload");
      await new Promise<void>((resolve, reject) => {
        express.json({ limit: bodyLimitBytes, strict: true })(req, res, (error) =>
          error ? reject(error) : resolve(),
        );
      });
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
        throw createApiError.badRequest("An artifact JSON object is required");
    }
    return true;
  } catch (error) {
    settleOwnerFrame(req, res);
    const fileTooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    const parserError = error as { type?: string; status?: number } | null;
    if (parserError?.type === "entity.too.large" || fileTooLarge) {
      res.status(413).json({
        success: false,
        error: {
          code: "ARTIFACT_SIZE_EXCEEDED",
          message: fileTooLarge
            ? "Artifact file exceeds the effective content size limit"
            : "Artifact request exceeds the effective JSON frame limit",
          details: { limit: maxContentBytes, bodyLimitBytes },
        },
      });
      return false;
    }
    if (error instanceof multer.MulterError)
      throw createApiError.badRequest("Artifact multipart metadata or part limits exceeded", {
        code: error.code,
        limit: maxContentBytes,
      });
    if (error instanceof Error && MALFORMED_MULTIPART_ERRORS.has(error.message))
      throw createApiError.badRequest("Invalid artifact multipart body");
    if (
      error &&
      typeof error === "object" &&
      "type" in error &&
      error.type === "entity.parse.failed"
    )
      throw createApiError.badRequest("Invalid artifact JSON");
    if (
      typeof parserError?.status === "number" &&
      parserError.status >= 400 &&
      parserError.status < 500
    )
      throw createApiError.badRequest("Invalid artifact request body");
    throw error;
  }
}

/** The artifact namespace owns session admission before and after its bounded JSON read. */
export function createArtifactSessionAdmission(
  policy: { getMaxFileSize(userId: string): Promise<number> },
  authenticate: RequestHandler,
): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const admit = () =>
      new Promise<boolean>((resolve, reject) => {
        const connection = res.getHeader("Connection");
        res.setHeader("Connection", "close");
        const refused = () => {
          res.off("finish", refused);
          res.off("close", refused);
          settleOwnerFrame(req, res);
          resolve(false);
        };
        res.once("finish", refused);
        res.once("close", refused);
        Promise.resolve(
          authenticate(req, res, (error) => {
            res.off("finish", refused);
            res.off("close", refused);
            if (error) return reject(error);
            if (connection === undefined) res.removeHeader("Connection");
            else res.setHeader("Connection", connection);
            resolve(true);
          }),
        ).catch(reject);
      });
    if (!(await admit())) return;
    if (req.method === "POST" || req.method === "PUT") {
      try {
        const userId = (req as AuthenticatedRequest).userId;
        if (!(await readArtifactBody(req, res, await policy.getMaxFileSize(userId)))) return;
        if (!(await admit())) return;
      } catch (error) {
        if (!req.readableEnded) settleOwnerFrame(req, res);
        throw error;
      }
    }
    next();
  });
}
