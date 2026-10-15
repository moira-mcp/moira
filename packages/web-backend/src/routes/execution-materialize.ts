import { Router, type Response } from "express";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import {
  communicationOwnerReceiptSchema,
  createLogger,
  materializeDownloadsTotal,
  parseCommunicationOwnerReference,
  TokenManager,
  ValidationError,
} from "@mcp-moira/shared";
import { createWorkspaceRequestId } from "@mcp-moira/shared/workspace-request-id";
import {
  authorizeMaterializeDelivery,
  DatabaseRepository,
  resolveMaterializeDelivery,
  type CommunicationFileOwner,
  type MaterializeDenialReason,
  type MaterializeExecutionSource,
  type MaterializeGrantStore,
} from "@mcp-moira/workflow-engine";
import { initializeCommunicationFileOwner } from "../services/communication-file-owner.js";

type ArchiveGrantStore = MaterializeGrantStore &
  Pick<TokenManager, "getMaterializeArchive" | "bindMaterializeArchive">;

const logger = createLogger({ component: "MaterializeDownload" });

function denyMaterialize(res: Response, reason: MaterializeDenialReason): void {
  materializeDownloadsTotal.inc({ outcome: "denied", reason });
  logger.warn("Materialize download denied", { reason });
  res.status(401).json({ error: "Invalid or expired materialize token" });
}

export function createExecutionMaterializeRoutes(
  tokens: ArchiveGrantStore = TokenManager.getInstance(),
  repository: MaterializeExecutionSource = new DatabaseRepository(),
  fileOwner?: CommunicationFileOwner,
): Router {
  const router = Router();
  router.get("/materialize/:token", async (req, res, next) => {
    const token = req.params.token;
    try {
      const authorized = await authorizeMaterializeDelivery(token, tokens, repository);
      if (!authorized.authorized) {
        denyMaterialize(res, authorized.reason);
        return;
      }
      let archive = tokens.getMaterializeArchive(token);
      const owner = fileOwner ?? initializeCommunicationFileOwner();
      let receipt: Record<string, unknown>;
      if (archive) {
        // Existing assignments are observations, even if the first dispatch was lost.
        receipt = await owner.collect(authorized.userId, archive.requestId, {
          deviceId: archive.owner.deviceId,
        });
      } else {
        const delivery = await resolveMaterializeDelivery(token, tokens, repository);
        if (!delivery.authorized) {
          denyMaterialize(res, delivery.reason);
          return;
        }
        const current = await authorizeMaterializeDelivery(token, tokens, repository);
        if (!current.authorized || current.contextRevision !== authorized.contextRevision) {
          denyMaterialize(res, "authorization_lost");
          return;
        }
        const selected = await owner.select(current.userId);
        const assignment = tokens.bindMaterializeArchive(
          token,
          current.executionId,
          current.nodeId,
          current.userId,
          current.contextRevision,
          { owner: selected, requestId: createWorkspaceRequestId() },
        );
        if (!assignment) {
          denyMaterialize(res, "authorization_lost");
          return;
        }
        archive = assignment.archive;
        receipt = assignment.created
          ? await owner.submit(
              current.userId,
              {
                action: "publish",
                requestId: archive.requestId,
                expectedScope: archive.owner,
                source: { type: "materialize-text-set", files: delivery.files },
              },
              archive.owner.deviceId,
            )
          : await owner.collect(current.userId, archive.requestId, {
              deviceId: archive.owner.deviceId,
            });
      }
      const result = communicationOwnerReceiptSchema.parse({
        requestId: receipt.requestId,
        state: receipt.state,
        stages: receipt.stages,
        outcome: receipt.outcome,
      });
      if (result.requestId !== archive.requestId)
        throw new Error("Owner returned a different archive operation");
      if (result.state !== "completed" || !result.outcome) {
        res.status(409).json({
          error:
            "The original archive publication is unconfirmed. Reuse this grant to collect it; request a fresh current-step presentation for an explicit retry.",
          code: "COMMUNICATION_OUTCOME_UNCONFIRMED",
          request_id: archive.requestId,
        });
        return;
      }
      if (!result.outcome.ok) {
        res.status(422).json({
          error: "The owner refused the archive source.",
          code: result.outcome.error.code,
          request_id: archive.requestId,
        });
        return;
      }
      const file = result.outcome.result.file;
      const reference = parseCommunicationOwnerReference(file.referenceId);
      if (
        reference.kind !== "controller" ||
        reference.id !== archive.owner.deviceId ||
        file.fileName !== "materialize.tar" ||
        file.mimeType !== "application/x-tar"
      )
        throw new Error("Owner returned an invalid archive publication");
      const opened = await owner.openPublication(authorized.userId, file.referenceId);
      const stream = Readable.from(opened.body);
      const settled = finished(stream).catch(() => undefined);
      try {
        const current = await authorizeMaterializeDelivery(token, tokens, repository);
        if (!current.authorized || current.contextRevision !== authorized.contextRevision) {
          denyMaterialize(res, "authorization_lost");
          return;
        }
        res.setHeader("Content-Type", "application/x-tar");
        res.setHeader("Content-Length", file.size);
        res.setHeader("Content-Disposition", 'attachment; filename="materialize.tar"');
        res.setHeader("Cache-Control", "no-store");
        await pipeline(stream, res);
        materializeDownloadsTotal.inc({ outcome: "success", reason: "authorized" });
      } finally {
        stream.destroy();
        await settled;
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        materializeDownloadsTotal.inc({ outcome: "failed", reason: "archive_invalid" });
        res.status(400).json({ error: "Materialize archive could not be generated" });
        return;
      }
      next(error);
    }
  });
  return router;
}
