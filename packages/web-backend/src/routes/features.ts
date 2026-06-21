/**
 * Feature Flags Route
 *
 * Public endpoint exposing the deployment mode and the resolved feature flags
 * so the frontend can hide SaaS-specific UI in self-host installs. No auth: the
 * registration and login pages (pre-auth) read this to decide which fields and
 * notices to render.
 */

import { Router, Request, Response } from "express";

import { ApiResponse } from "../types/index.js";
import { asyncHandler } from "../middleware/error-middleware.js";
import { getDeploymentMode, getFeatureResolver, getMcpUrl, type Feature } from "@mcp-moira/shared";

const router = Router();

/** All gated features, surfaced to the frontend. */
const FEATURES: Feature[] = [
  "openRegistration",
  "emailVerificationGate",
  "verificationEmailOnSignup",
  "legalConsents",
  "betaNotices",
  "multiUserAdmin",
  "socialLogin",
];

export interface FeaturesResponse {
  deploymentMode: ReturnType<typeof getDeploymentMode>;
  features: Record<Feature, boolean>;
  /**
   * MCP endpoint URL resolved at runtime from the server's own host config
   * (MOIRA_HOST), e.g. "http://localhost:8077/mcp". The frontend uses this
   * instead of a build-time-baked value so the displayed MCP URL is correct
   * on whatever host/port the running instance is actually served from.
   */
  mcpUrl: string;
}

/**
 * GET /api/features - Deployment mode + resolved feature flags + runtime MCP URL
 */
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    const resolver = getFeatureResolver();
    const features = Object.fromEntries(FEATURES.map((f) => [f, resolver.isEnabled(f)])) as Record<
      Feature,
      boolean
    >;

    const response: ApiResponse<FeaturesResponse> = {
      success: true,
      data: { deploymentMode: getDeploymentMode(), features, mcpUrl: getMcpUrl() },
      timestamp: new Date().toISOString(),
    };

    res.json(response);
  }),
);

export { router as featuresRoutes };
