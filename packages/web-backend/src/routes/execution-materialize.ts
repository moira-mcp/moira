import { Router, type Response } from "express";
import {
  createLogger,
  materializeDownloadsTotal,
  TokenManager,
  ValidationError,
} from "@mcp-moira/shared";
import {
  createMaterializeTar,
  DatabaseRepository,
  resolveMaterializeDelivery,
  type MaterializeDenialReason,
  type MaterializeExecutionSource,
  type MaterializeGrantStore,
} from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "MaterializeDownload" });

function denyMaterialize(res: Response, reason: MaterializeDenialReason): void {
  materializeDownloadsTotal.inc({ outcome: "denied", reason });
  logger.warn("Materialize download denied", { reason });
  res.status(401).json({ error: "Invalid or expired materialize token" });
}

export function createExecutionMaterializeRoutes(
  tokens: MaterializeGrantStore = TokenManager.getInstance(),
  repository: MaterializeExecutionSource = new DatabaseRepository(),
): Router {
  const router = Router();
  router.get("/materialize/:token", async (req, res, next) => {
    const token = req.params.token;
    try {
      const delivery = await resolveMaterializeDelivery(token, tokens, repository);
      if (!delivery.authorized) {
        denyMaterialize(res, delivery.reason);
        return;
      }

      const archive = await createMaterializeTar(delivery.files);
      materializeDownloadsTotal.inc({ outcome: "success", reason: "authorized" });
      res.setHeader("Content-Type", "application/x-tar");
      res.setHeader("Content-Disposition", 'attachment; filename="materialize.tar"');
      res.send(archive);
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
