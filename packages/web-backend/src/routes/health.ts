/**
 * Health Check and Configuration Routes
 * System status, health monitoring, and configuration endpoints
 */

import { Router, Request, Response } from "express";

import { ApiResponse, HealthCheckResponse, ServerConfigResponse } from "../types/index.js";

import { asyncHandler } from "../middleware/error-middleware.js";
import { WorkflowValidationService } from "../services/validation-service.js";
import { getWebBackendPort, getNodeEnv } from "@mcp-moira/shared";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";

const router = Router();

// Create repository instance (uses shared database singleton)
const repository = new DatabaseRepository();

/**
 * GET /api/health - System health check
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    // Check all system components
    const checks = await Promise.allSettled([
      checkDatabase(),
      checkValidationSystem(),
      checkMcpEngine(),
    ]);

    const databaseOk = checks[0].status === "fulfilled" && checks[0].value;
    const validationOk = checks[1].status === "fulfilled" && checks[1].value;
    const mcpEngineOk = checks[2].status === "fulfilled" && checks[2].value;

    const allHealthy = databaseOk && validationOk; // Skip mcpEngine check for Web UI

    const healthResponse: HealthCheckResponse = {
      status: allHealthy ? "ok" : "error",
      services: {
        fileSystem: databaseOk,
        validation: validationOk,
        mcpEngine: mcpEngineOk,
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      version: "0.1.0",
    };

    const apiResponse: ApiResponse<HealthCheckResponse> = {
      success: allHealthy,
      data: healthResponse,
      timestamp: new Date().toISOString(),
    };

    // Set appropriate HTTP status
    const statusCode = allHealthy ? 200 : 503; // Service Unavailable if unhealthy
    res.status(statusCode).json(apiResponse);
  }),
);

/**
 * GET /api/config - Server configuration
 */
router.get(
  "/config",
  asyncHandler(async (req: Request, res: Response) => {
    const configResponse: ServerConfigResponse = {
      workflowDirectories: ["database"],
      defaultFolders: [],
      serverPort: getWebBackendPort(),
      environment: (getNodeEnv() as "development" | "production") || "development",
      features: {
        caching: false,
        fileWatching: false,
        authentication: true,
      },
    };

    const apiResponse: ApiResponse<ServerConfigResponse> = {
      success: true,
      data: configResponse,
      timestamp: new Date().toISOString(),
    };

    res.json(apiResponse);
  }),
);

/**
 * GET /api/status - Detailed system status
 */
router.get(
  "/status",
  asyncHandler(async (req: Request, res: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId || "system-admin";
    const validationService = new WorkflowValidationService();

    const [workflows, validationStatus] = await Promise.all([
      repository.listWorkflows(userId),
      validationService.getValidationSystemStatus(),
    ]);

    const statusResponse = {
      server: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        nodeVersion: process.version,
        platform: process.platform,
      },
      workflows: {
        totalWorkflows: workflows.length,
      },
      validation: validationStatus,
      features: {
        caching: false,
        fileWatching: false,
        authentication: true,
      },
    };

    const apiResponse: ApiResponse = {
      success: true,
      data: statusResponse,
      timestamp: new Date().toISOString(),
    };

    res.json(apiResponse);
  }),
);

/**
 * Health check helper functions
 */

async function checkDatabase(): Promise<boolean> {
  try {
    await repository.listWorkflows("system-admin");
    return true;
  } catch {
    return false;
  }
}

async function checkValidationSystem(): Promise<boolean> {
  try {
    const validationService = new WorkflowValidationService();
    const status = validationService.getValidationSystemStatus();
    return status.available;
  } catch {
    return false;
  }
}

async function checkMcpEngine(): Promise<boolean> {
  try {
    // Check if MCP engine is available
    try {
      const { GraphValidator } = await import("@mcp-moira/workflow-engine");
      const _validator = new GraphValidator();
      return true;
    } catch {
      return false;
    }
  } catch {
    // MCP engine not accessible (might be in different location)
    return false;
  }
}

export { router as healthRoutes };
