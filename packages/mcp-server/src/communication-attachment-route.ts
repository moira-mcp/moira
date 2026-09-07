import type { Request, RequestHandler, Response } from "express";
import {
  AuditAction,
  type CommunicationAttachmentGrantService,
  MAX_COMMUNICATION_ATTACHMENT_BYTES,
  type logAuditEvent,
} from "@mcp-moira/shared";
import type { DatabaseRepository, UserCommunicationService } from "@mcp-moira/workflow-engine";
import type { CommunicationAttachmentInflightLimiter } from "./communication-attachment-inflight.js";

type AuthenticatedPrincipal = { identity: { userId: string } };

export interface CommunicationAttachmentRouteDependencies {
  authenticate(req: Request, res: Response, method: string): Promise<AuthenticatedPrincipal | null>;
  grantService: Pick<CommunicationAttachmentGrantService, "reserve" | "release" | "complete">;
  inflight: Pick<CommunicationAttachmentInflightLimiter, "acquire">;
  communicationService: Pick<UserCommunicationService, "deliver">;
  createRepository(): DatabaseRepository;
  audit: typeof logAuditEvent;
  logger: { error(message: string, error: unknown): void };
}

export type AttachmentBodyResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: 400 | 413; error: "body_size_mismatch" | "attachment_too_large" };

export async function readCommunicationAttachmentBody(
  source: AsyncIterable<unknown>,
  declaredLength: number,
): Promise<AttachmentBodyResult> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.length;
    if (received > declaredLength || received > MAX_COMMUNICATION_ATTACHMENT_BYTES) {
      return { ok: false, status: 413, error: "attachment_too_large" };
    }
    chunks.push(buffer);
  }
  if (received !== declaredLength) {
    return { ok: false, status: 400, error: "body_size_mismatch" };
  }
  return { ok: true, bytes: Buffer.concat(chunks, received) };
}

function hasExpectedImageSignature(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    );
  }
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function createCommunicationAttachmentHandler(
  dependencies: CommunicationAttachmentRouteDependencies,
): RequestHandler {
  return async (req, res) => {
    let reserved: ReturnType<CommunicationAttachmentGrantService["reserve"]> = null;
    let releaseLease: (() => void) | null = null;
    let deliveryInvoked = false;
    try {
      const principal = await dependencies.authenticate(req, res, "communication/attachment");
      if (!principal) return;
      const grantHeader = req.get("x-moira-communication-grant");
      if (!grantHeader || grantHeader.length > 256) {
        res.status(401).json({ error: "invalid_grant" });
        return;
      }
      reserved = dependencies.grantService.reserve(grantHeader, principal.identity.userId);
      if (!reserved) {
        res.status(401).json({ error: "invalid_grant" });
        return;
      }

      const contentLengthHeader = req.get("content-length");
      if (!contentLengthHeader) {
        dependencies.grantService.release(reserved.tokenDigest, reserved.claimId);
        res.status(411).json({ error: "content_length_required" });
        return;
      }
      const contentLength = Number(contentLengthHeader);
      const contentType = (req.get("content-type") ?? "").toLowerCase();
      if (!Number.isSafeInteger(contentLength) || contentLength !== reserved.declaredSize) {
        dependencies.grantService.release(reserved.tokenDigest, reserved.claimId);
        res
          .status(contentLength > MAX_COMMUNICATION_ATTACHMENT_BYTES ? 413 : 400)
          .json({ error: "declared_size_mismatch" });
        return;
      }
      if (contentType !== reserved.mimeType) {
        dependencies.grantService.release(reserved.tokenDigest, reserved.claimId);
        res.status(400).json({ error: "mime_type_mismatch" });
        return;
      }
      releaseLease = dependencies.inflight.acquire(principal.identity.userId, contentLength);
      if (!releaseLease) {
        dependencies.grantService.release(reserved.tokenDigest, reserved.claimId);
        res.status(429).json({ error: "attachment_inflight_limit" });
        return;
      }

      const body = await readCommunicationAttachmentBody(req, contentLength);
      if (!body.ok) {
        dependencies.grantService.release(reserved.tokenDigest, reserved.claimId);
        res.status(body.status).json({ error: body.error });
        return;
      }
      if (reserved.kind === "image" && !hasExpectedImageSignature(reserved.mimeType, body.bytes)) {
        dependencies.grantService.release(reserved.tokenDigest, reserved.claimId);
        res.status(400).json({ error: "invalid_image_signature" });
        return;
      }

      deliveryInvoked = true;
      const repository = dependencies.createRepository();
      const delivery = await dependencies.communicationService.deliver(
        {
          userId: principal.identity.userId,
          text: reserved.message,
          format: reserved.format,
          silent: reserved.silent,
          purpose: "notification",
          attachment: {
            kind: reserved.kind,
            bytes: body.bytes,
            filename: reserved.filename,
            mimeType: reserved.mimeType,
          },
        },
        repository,
      );
      await dependencies.audit(repository, req, {
        userId: principal.identity.userId,
        action: AuditAction.MCP_COMMUNICATION_ATTACHMENT_DELIVER,
        resource: "communication",
        resourceId: reserved.correlationId,
        metadata: {
          kind: reserved.kind,
          declaredSize: reserved.declaredSize,
          receivedSize: body.bytes.length,
          status: delivery.status,
          configuredChannels: delivery.configuredChannels,
          deliveredChannels: delivery.deliveredChannels,
        },
      });
      res
        .status(delivery.status === "all_failed" ? 502 : 200)
        .json({ correlationId: reserved.correlationId, ...delivery });
    } catch (error) {
      dependencies.logger.error("Communication attachment request failed", error);
      if (!res.headersSent) res.status(500).json({ error: "communication_delivery_failed" });
    } finally {
      if (reserved && deliveryInvoked) {
        dependencies.grantService.complete(reserved.tokenDigest, reserved.claimId);
      } else if (reserved) {
        dependencies.grantService.release(reserved.tokenDigest, reserved.claimId);
      }
      releaseLease?.();
    }
  };
}
