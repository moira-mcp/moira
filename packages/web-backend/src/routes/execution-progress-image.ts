import { Router, type NextFunction, type Request, type Response } from "express";
import { DatabaseRepository, ProgressImageService } from "@mcp-moira/workflow-engine";
import { initializeCommunicationFileOwner } from "../services/communication-file-owner.js";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function createExecutionProgressImageRoutes(
  progressImages = new ProgressImageService(new DatabaseRepository()),
): Router {
  initializeCommunicationFileOwner();
  const router = Router();
  router.get("/:token", (req, res, next) => redeemProgressImage(req, res, next, progressImages));
  return router;
}

export async function redeemProgressImage(
  req: Request,
  res: Response,
  next: NextFunction,
  progressImages: ProgressImageService,
): Promise<void> {
  const token = req.params.token;
  let redemption: Awaited<ReturnType<ProgressImageService["redeem"]>> = null;
  let onClose: (() => void) | undefined;
  let release: Promise<boolean> | undefined;
  try {
    redemption = await progressImages.redeem(token);
    if (!redemption) {
      res.status(401).json({ error: "Invalid or expired progress image token" });
      return;
    }
    const { claimId } = redemption;
    onClose = () => {
      if (!res.writableFinished && !release) {
        release = Promise.resolve(progressImages.release(token, claimId));
        // The owner may still be opening the source. Observe the failure until the route collects it.
        void release.catch(() => {});
      }
    };
    res.once("close", onClose);
    if (res.destroyed) onClose();
    const source = await progressImages.open(redemption);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    await pipeline(Readable.from(source.body), res);
    await progressImages.complete(token, claimId);
  } catch (error) {
    try {
      if (redemption && !res.writableFinished)
        await (release ?? progressImages.release(token, redemption.claimId));
    } catch (releaseError) {
      next(new AggregateError([error, releaseError], "Failed to serve and release progress image"));
      return;
    }
    next(error);
  } finally {
    if (onClose) res.off("close", onClose);
  }
}
