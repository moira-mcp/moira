import { Router, type NextFunction, type Request, type Response } from "express";
import { DatabaseRepository, ProgressImageService } from "@mcp-moira/workflow-engine";

export function createExecutionProgressImageRoutes(
  progressImages = new ProgressImageService(new DatabaseRepository()),
): Router {
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
  try {
    redemption = await progressImages.redeem(token);
    if (!redemption) {
      res.status(401).json({ error: "Invalid or expired progress image token" });
      return;
    }
    let settled = false;
    res.once("finish", () => {
      settled = true;
      progressImages.complete(token, redemption!.claimId);
    });
    res.once("close", () => {
      if (!settled) progressImages.release(token, redemption!.claimId);
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(redemption.png);
  } catch (error) {
    if (redemption) progressImages.release(token, redemption.claimId);
    next(error);
  }
}
