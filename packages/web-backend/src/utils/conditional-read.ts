import { createHash } from "node:crypto";
import type { Request, Response } from "express";

/** Call only after authorization and the current source/service read, including its audit effects. */
export function sendConditionalRead<T>(
  req: Request,
  res: Response,
  data: T,
  options: { scope: string; timestamp?: string },
): void {
  const digest = createHash("sha256")
    .update(JSON.stringify([options.scope, data]))
    .digest("base64url");
  res.setHeader("ETag", `W/"${digest}"`);
  res.setHeader("Cache-Control", "private, no-cache");
  res.vary("Cookie");
  res.vary("Authorization");
  if (req.fresh) {
    res.status(304).end();
    return;
  }
  res.json({ success: true, data, ...(options.timestamp ? { timestamp: options.timestamp } : {}) });
}
