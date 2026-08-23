/**
 * Deployment capability authorization.
 *
 * Capability decisions are security facts, not UI hints. These guards always
 * resolve through the shared FeatureResolver singleton also used by
 * GET /api/features, so a private resolver override changes exposure and
 * authorization together. Resolver errors and unknown capability names fail
 * closed.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AuthorizationError, getFeatureResolver, type Feature } from "@mcp-moira/shared";
import type { AuthenticatedRequest } from "../types/express-types.js";

export type CapabilitySelector = (req: Request) => Feature | null;

function denyCapability(next: NextFunction, capability: Feature): void {
  next(
    new AuthorizationError("This capability is not enabled for the current deployment", {
      capability,
    }),
  );
}

/** Require one named deployment capability. */
export function requireCapability(capability: Feature): RequestHandler {
  return requireSelectedCapability(() => capability);
}

/**
 * Resolve the required capability from the mounted request path. Returning
 * null declares that the route has no deployment-specific capability gate.
 */
export function requireSelectedCapability(selectCapability: CapabilitySelector): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const capability = selectCapability(req);
    if (capability === null) {
      next();
      return;
    }

    let enabled = false;
    try {
      enabled =
        getFeatureResolver().isEnabled(capability, {
          userId: (req as AuthenticatedRequest).userId,
        }) === true;
    } catch {
      enabled = false;
    }

    if (!enabled) {
      denyCapability(next, capability);
      return;
    }

    next();
  };
}
