import type { Request, RequestHandler, Response } from "express";
import {
  AuditAction,
  CodespaceResourceError,
  type CommunicationAttachmentGrantService,
  MAX_COMMUNICATION_ATTACHMENT_BYTES,
  type logAuditEvent,
  type CodespaceTransferService,
  type CodespaceTransferRecord,
  type CodespaceVerifiedByteStream,
} from "@mcp-moira/shared";
import type { DatabaseRepository, UserCommunicationService } from "@mcp-moira/workflow-engine";
import type { CommunicationAttachmentInflightLimiter } from "./communication-attachment-inflight.js";

type AuthenticatedPrincipal = { identity: { userId: string } };

export interface CommunicationAttachmentRouteDependencies {
  authenticate(req: Request, res: Response, method: string): Promise<AuthenticatedPrincipal | null>;
  grantService: Pick<CommunicationAttachmentGrantService, "reserve" | "release" | "complete">;
  inflight: Pick<CommunicationAttachmentInflightLimiter, "acquire">;
  communicationService: Pick<UserCommunicationService, "deliver">;
  transfers: Pick<CodespaceTransferService, "ingestStream" | "getOwnedSource" | "discard">;
  createRepository(): DatabaseRepository;
  audit: typeof logAuditEvent;
  logger: { error(message: string, error: unknown): void };
}

class AttachmentBodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: string,
  ) {
    super(code);
  }
}

async function* communicationAttachmentBody(
  source: AsyncIterable<unknown>,
  declaredLength: number,
): AsyncIterable<Uint8Array> {
  let received = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.length;
    if (received > declaredLength || received > MAX_COMMUNICATION_ATTACHMENT_BYTES) {
      throw new AttachmentBodyError(413, "attachment_too_large");
    }
    yield buffer;
  }
  if (received !== declaredLength) {
    throw new AttachmentBodyError(400, "body_size_mismatch");
  }
}

export function createCommunicationAttachmentHandler(
  dependencies: CommunicationAttachmentRouteDependencies,
): RequestHandler {
  return async (req, res) => {
    let reserved: ReturnType<CommunicationAttachmentGrantService["reserve"]> = null;
    let releaseLease: (() => void) | null = null;
    let deliveryInvoked = false;
    let temporary: CodespaceTransferRecord | null = null;
    const opened = new Set<CodespaceVerifiedByteStream>();
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

      if (reserved.kind === "image" && !["image/png", "image/jpeg"].includes(reserved.mimeType)) {
        dependencies.grantService.release(reserved.tokenDigest, reserved.claimId);
        res.status(400).json({ error: "invalid_image_signature" });
        return;
      }

      const transfer = await dependencies.transfers.ingestStream(principal.identity.userId, {
        fileName: reserved.filename,
        mimeType: reserved.mimeType,
        size: contentLength,
        body: communicationAttachmentBody(req, contentLength),
      });
      const owned = await dependencies.transfers.getOwnedSource(
        principal.identity.userId,
        transfer.referenceId,
      );
      temporary = owned.record;

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
            source: {
              size: owned.source.size,
              sha256: owned.source.sha256,
              async open(signal) {
                const stream = await owned.source.open(signal);
                opened.add(stream);
                return stream;
              },
            },
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
          receivedSize: owned.source.size,
          status: delivery.status,
          configuredChannels: delivery.configuredChannels,
          deliveredChannels: delivery.deliveredChannels,
        },
      });
      res
        .status(delivery.status === "all_failed" ? 502 : 200)
        .json({ correlationId: reserved.correlationId, ...delivery });
    } catch (error) {
      if (error instanceof AttachmentBodyError) {
        if (!res.headersSent) res.status(error.status).json({ error: error.code });
        return;
      }
      if (error instanceof CodespaceResourceError && !deliveryInvoked) {
        if (!res.headersSent) {
          res.status(error.code === "CODESPACE_POLICY_LIMIT" ? 429 : 400).json({
            error:
              error.code === "CODESPACE_POLICY_LIMIT"
                ? "attachment_storage_limit"
                : reserved?.kind === "image"
                  ? "invalid_image_signature"
                  : "invalid_attachment",
          });
        }
        return;
      }
      dependencies.logger.error("Communication attachment request failed", error);
      if (!res.headersSent) res.status(500).json({ error: "communication_delivery_failed" });
    } finally {
      if (reserved && deliveryInvoked) {
        dependencies.grantService.complete(reserved.tokenDigest, reserved.claimId);
      } else if (reserved) {
        dependencies.grantService.release(reserved.tokenDigest, reserved.claimId);
      }
      await Promise.allSettled([...opened].map((stream) => stream.close()));
      await Promise.all([...opened].map((stream) => stream.settled));
      if (temporary) {
        await dependencies.transfers
          .discard(temporary)
          .catch((error) =>
            dependencies.logger.error("Temporary communication object cleanup failed", error),
          );
      }
      releaseLease?.();
    }
  };
}
