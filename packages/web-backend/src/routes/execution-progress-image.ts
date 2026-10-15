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
  let completeResponse: (() => void) | undefined;
  let releaseResponse: (() => void) | undefined;
  try {
    redemption = await progressImages.redeem(token);
    if (!redemption) {
      res.status(401).json({ error: "Invalid or expired progress image token" });
      return;
    }
    let settled = false;
    completeResponse = () => {
      settled = true;
      progressImages.complete(token, redemption!.claimId);
    };
    releaseResponse = () => {
      if (!settled) progressImages.release(token, redemption!.claimId);
    };
    res.once("finish", completeResponse);
    res.once("close", releaseResponse);
    const source = await progressImages.open(redemption);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    await pipeline(Readable.from(source.body), res);
  } catch (error) {
    // An error response finishing is not a successful publication response.
    if (completeResponse) res.off("finish", completeResponse);
    if (releaseResponse) res.off("close", releaseResponse);
    if (redemption) progressImages.release(token, redemption.claimId);
    next(error);
  }
}
