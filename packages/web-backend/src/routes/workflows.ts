/**
 * Workflow Management Routes
 * REST API endpoints for workflow data and validation
 *
 * Architecture: Backend returns raw workflow data, frontend handles transformation
 * for visualization (WorkflowTransformer, LayoutEngine on client side)
 */

import { Router, Request, Response } from "express";
import {
  ApiResponse,
  WorkflowListResponse,
  WorkflowDetailResponse,
  WorkflowValidationResponse,
  WorkflowListRequest,
  WorkflowDetailRequest,
  WorkflowValidationRequest,
  RawWorkflowResponse,
  AuthenticatedRequest,
} from "../types/index.js";

import {
  asyncHandler,
  createApiError,
  validateParams,
  paramValidators,
} from "../middleware/error-middleware.js";
import { WorkflowValidationService } from "../services/validation-service.js";
import { DatabaseRepository, WorkflowGraph, GraphNode } from "@mcp-moira/workflow-engine";
import { getWorkflowService, validateSlug } from "@mcp-moira/shared";

const router = Router();

// Create repository instance (uses shared database singleton)
const repository = new DatabaseRepository();

// Get WorkflowService for operations with automatic audit
const workflowService = getWorkflowService();

/**
 * Helper to resolve workflow identifier (UUID, slug, or handle/slug) to actual UUID
 * Used for mutation operations that need the real workflow ID
 */
async function resolveWorkflowId(identifier: string, userId: string): Promise<string | null> {
  // Check if this is a handle/slug reference (contains exactly one slash)
  if (identifier.includes("/") && identifier.split("/").length === 2) {
    // Use getByReference for handle/slug format
    const { workflow } = await workflowService.getByReference(identifier, userId);
    if (workflow) {
      return workflow.id ?? null;
    }
    return null;
  }

  // First try as UUID directly
  const workflow = await workflowService.get(identifier, userId);
  if (workflow) {
    return identifier;
  }

  // Try as slug for current user
  const workflowBySlug = await workflowService.getBySlug(identifier, userId);
  if (workflowBySlug) {
    return workflowBySlug.id ?? null;
  }

  return null;
}

/**
 * GET /api/workflows - List all workflows with filtering, sorting, and pagination
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const query: WorkflowListRequest = req.query as WorkflowListRequest;
    const userId = (req as AuthenticatedRequest).userId; // From requireAuth middleware

    // Parse query parameters
    const search = query.search as string | undefined;
    const visibility = query.visibility as "public" | "private" | "all" | undefined;
    const sort = (query.sort as "createdAt" | "name") || "createdAt";
    const sortOrder = (query.sortOrder as "asc" | "desc") || "desc";
    const limit = Math.min(Math.max(1, parseInt(query.limit as string) || 20), 100);
    const offset = Math.max(0, parseInt(query.offset as string) || 0);

    // Get workflows with filters from repository
    const result = await repository.listWorkflowsWithFilters({
      userId,
      search,
      visibility,
      sort,
      sortOrder,
      limit,
      offset,
    });

    // Use cached validation from repository (no runtime validation for performance)
    const convertedWorkflows = result.workflows.map((w) => ({
      id: w.id,
      slug: w.slug,
      ownerHandle: w.ownerHandle,
      ownerName: w.userId === "system-admin" ? "System" : w.userId.split("-")[0],
      visibility: w.visibility,
      accessType: w.accessType,
      filePath: w.storagePath,
      metadata: w.metadata,
      validation: {
        isValid: w.validation.status === "valid",
        status: w.validation.status,
        errors: w.validation.errors,
      },
      lastModified: w.updatedAt,
      fileSize: w.size,
    }));

    // Apply validation status filter if provided
    let filteredWorkflows = convertedWorkflows;

    if (query.validationStatus && query.validationStatus !== "all") {
      filteredWorkflows = filteredWorkflows.filter((workflow) => {
        // Use cached status directly (supports "unknown" status)
        return workflow.validation.status === query.validationStatus;
      });
    }

    // Calculate totals
    const totalWorkflows = result.total;
    const validWorkflows = filteredWorkflows.filter((w) => w.validation.isValid).length;

    const response: WorkflowListResponse = {
      workflows: filteredWorkflows,
      totalWorkflows,
      validWorkflows,
      invalidWorkflows: filteredWorkflows.length - validWorkflows,
      lastScan: Date.now(),
    };

    const apiResponse: ApiResponse<WorkflowListResponse> = {
      success: true,
      data: response,
      timestamp: new Date().toISOString(),
    };

    // Add custom headers
    res.set("X-Total-Count", totalWorkflows.toString());
    res.set("X-Valid-Count", validWorkflows.toString());
    res.set("X-Limit", limit.toString());
    res.set("X-Offset", offset.toString());

    res.json(apiResponse);
  }),
);

/**
 * GET /api/workflows/by-slug/:slug - Get workflow by slug (current user's workflow)
 * IMPORTANT: This route must be defined BEFORE /:id to avoid being shadowed
 */
router.get(
  "/by-slug/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;
    const userId = (req as AuthenticatedRequest).userId;

    // Get workflow by slug
    const workflow = await workflowService.getBySlug(slug, userId);
    if (!workflow) {
      throw createApiError.notFound(`Workflow not found: ${slug}`);
    }

    // Get full info for response
    const info = await workflowService.getFullInfo(workflow.id, userId);
    if (!info) {
      throw createApiError.notFound(`Workflow not found: ${slug}`);
    }

    const validationService = new WorkflowValidationService();
    const validation = await validationService.validateWorkflow(workflow);

    const fileInfo = {
      id: info.id,
      slug: info.slug,
      ownerHandle: info.ownerHandle,
      ownerName: info.userId === "system-admin" ? "System" : info.userId.split("-")[0],
      visibility: info.visibility,
      accessType: info.accessType,
      filePath: info.storagePath,
      metadata: info.metadata,
      validation: validation,
      lastModified: info.updatedAt,
      fileSize: info.size,
    };

    const response: WorkflowDetailResponse = {
      workflow,
      validation,
      fileInfo,
    };

    res.json({
      success: true,
      data: response,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/workflows/by-reference/:handle/:slug - Get workflow by handle/slug reference
 * Supports public access to another user's public workflow
 * IMPORTANT: This route must be defined BEFORE /:handle/:slug to avoid being shadowed
 */
router.get(
  "/by-reference/:handle/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const { handle, slug } = req.params;
    const userId = (req as AuthenticatedRequest).userId;
    const reference = `${handle}/${slug}`;

    // Get workflow by global reference
    const { workflow, info } = await workflowService.getByReference(reference, userId);

    const validationService = new WorkflowValidationService();
    const validation = await validationService.validateWorkflow(workflow);

    const fileInfo = {
      id: info.id,
      slug: info.slug,
      ownerHandle: info.ownerHandle,
      ownerName: info.userId === "system-admin" ? "System" : info.userId.split("-")[0],
      visibility: info.visibility,
      accessType: info.accessType,
      filePath: info.storagePath,
      metadata: info.metadata,
      validation: validation,
      lastModified: info.updatedAt,
      fileSize: info.size,
    };

    const response: WorkflowDetailResponse = {
      workflow,
      validation,
      fileInfo,
    };

    res.json({
      success: true,
      data: response,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/workflows/:id - Get specific workflow
 *
 * Returns raw workflow data. Frontend handles transformation for visualization.
 * Supports optional pagination for large workflows.
 *
 * Accepts workflow identifier as:
 * - UUID (e.g., "550e8400-e29b-41d4-a716-446655440000")
 * - Slug (e.g., "quick-task") - resolved for current user
 */
router.get(
  "/:id",
  validateParams({
    id: paramValidators.workflowId,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const query: WorkflowDetailRequest = req.query as WorkflowDetailRequest;
    const userId = (req as AuthenticatedRequest).userId;

    // Extract pagination params from query
    const offset = query.offset !== undefined ? parseInt(String(query.offset), 10) : undefined;
    const limit = query.limit !== undefined ? parseInt(String(query.limit), 10) : undefined;

    const validationService = new WorkflowValidationService();

    try {
      // Get workflow data - try by ID first, then by slug
      // This allows frontend to use slug-based URLs
      let workflowInfo = await repository.getWorkflow(id, userId);

      // If not found by ID, try resolving as slug for current user
      if (!workflowInfo || !workflowInfo.workflow) {
        const workflowBySlug = await workflowService.getBySlug(id, userId);
        if (workflowBySlug) {
          // Get full info using the resolved workflow ID
          workflowInfo = await workflowService.getFullInfo(workflowBySlug.id, userId);
        }
      }

      if (!workflowInfo || !workflowInfo.workflow) {
        throw createApiError.notFound(`Workflow not found: ${id}`);
      }

      const workflow = workflowInfo.workflow;

      // Apply pagination if requested
      const totalNodes = workflow.nodes.length;
      const hasPagination = offset !== undefined && limit !== undefined;
      const paginatedNodes = hasPagination
        ? workflow.nodes.slice(offset, offset + limit)
        : workflow.nodes;
      const hasMore = hasPagination ? offset + limit < totalNodes : false;

      // Create paginated workflow
      const paginatedWorkflow = hasPagination ? { ...workflow, nodes: paginatedNodes } : workflow;

      // Validate workflow if requested (use full workflow for validation, not paginated)
      let validation;
      if (query.includeValidation !== false) {
        validation = await validationService.validateWorkflow(workflow);
      } else {
        // Create basic validation status without full validation
        validation = {
          isValid: true,
          globalErrors: [],
          globalWarnings: [],
          nodeValidation: {},
        };
      }

      const fileInfo = {
        id: workflowInfo.id,
        slug: workflowInfo.slug,
        ownerHandle: workflowInfo.ownerHandle,
        ownerName:
          workflowInfo.userId === "system-admin" ? "System" : workflowInfo.userId.split("-")[0],
        visibility: workflowInfo.visibility,
        accessType: workflowInfo.accessType,
        filePath: workflowInfo.storagePath,
        metadata: workflowInfo.metadata,
        validation: validation,
        lastModified: workflowInfo.updatedAt,
        fileSize: workflowInfo.size,
      };

      // Response contains raw workflow - no visualization transformation
      // Frontend handles visualization via WorkflowTransformer + LayoutEngine
      const response: WorkflowDetailResponse & {
        totalNodes: number;
        hasMore?: boolean;
        offset?: number;
        limit?: number;
        returnedNodes?: number;
      } = {
        workflow: paginatedWorkflow,
        validation,
        fileInfo,
        totalNodes,
      };

      // Add pagination metadata
      if (hasPagination) {
        response.hasMore = hasMore;
        response.offset = offset;
        response.limit = limit;
        response.returnedNodes = paginatedNodes.length;
      }

      const apiResponse: ApiResponse<WorkflowDetailResponse> = {
        success: true,
        data: response,
        timestamp: new Date().toISOString(),
      };

      res.set("X-Validation-Status", validation.isValid ? "valid" : "invalid");
      res.set("X-Node-Count", totalNodes.toString());
      res.set("X-Total-Nodes", totalNodes.toString());
      if (hasPagination) {
        res.set("X-Returned-Nodes", paginatedNodes.length.toString());
        res.set("X-Has-More", hasMore.toString());
      }

      res.json(apiResponse);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw createApiError.notFound(`Workflow not found: ${id}`);
      }
      throw error;
    }
  }),
);

/**
 * GET /api/workflows/:handle/:slug - Get workflow by handle/slug reference
 *
 * This is the canonical user-facing URL format for workflows.
 * Supports accessing public workflows from any user via their handle.
 *
 * @param handle - User handle (e.g., "admin", "john")
 * @param slug - Workflow slug (e.g., "quick-task")
 */
router.get(
  "/:handle/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const { handle, slug } = req.params;
    const query: WorkflowDetailRequest = req.query as WorkflowDetailRequest;
    const userId = (req as AuthenticatedRequest).userId;

    // Validate handle and slug format
    if (!handle || !slug) {
      throw createApiError.badRequest("Both handle and slug are required");
    }

    // Construct reference in handle/slug format
    const reference = `${handle}/${slug}`;

    const validationService = new WorkflowValidationService();

    try {
      // Use getByReference which handles handle resolution and access check
      const { workflow, info: workflowInfo } = await workflowService.getByReference(
        reference,
        userId,
      );

      // Extract pagination params from query
      const offset = query.offset !== undefined ? parseInt(String(query.offset), 10) : undefined;
      const limit = query.limit !== undefined ? parseInt(String(query.limit), 10) : undefined;

      // Apply pagination if requested
      const totalNodes = workflow.nodes.length;
      const hasPagination = offset !== undefined && limit !== undefined;
      const paginatedNodes = hasPagination
        ? workflow.nodes.slice(offset, offset + limit)
        : workflow.nodes;
      const hasMore = hasPagination ? offset + limit < totalNodes : false;

      // Create paginated workflow
      const paginatedWorkflow = hasPagination ? { ...workflow, nodes: paginatedNodes } : workflow;

      // Validate workflow if requested
      let validation;
      if (query.includeValidation !== false) {
        validation = await validationService.validateWorkflow(workflow);
      } else {
        validation = {
          isValid: true,
          globalErrors: [],
          globalWarnings: [],
          nodeValidation: {},
        };
      }

      const fileInfo = {
        id: workflowInfo.id,
        slug: workflowInfo.slug,
        ownerHandle: workflowInfo.ownerHandle,
        ownerName:
          workflowInfo.userId === "system-admin" ? "System" : workflowInfo.userId.split("-")[0],
        visibility: workflowInfo.visibility,
        accessType: workflowInfo.accessType,
        filePath: workflowInfo.storagePath,
        metadata: workflowInfo.metadata,
        validation: validation,
        lastModified: workflowInfo.updatedAt,
        fileSize: workflowInfo.size,
      };

      const response: WorkflowDetailResponse & {
        totalNodes: number;
        hasMore?: boolean;
        offset?: number;
        limit?: number;
        returnedNodes?: number;
      } = {
        workflow: paginatedWorkflow,
        validation,
        fileInfo,
        totalNodes,
      };

      if (hasPagination) {
        response.hasMore = hasMore;
        response.offset = offset;
        response.limit = limit;
        response.returnedNodes = paginatedNodes.length;
      }

      const apiResponse: ApiResponse<WorkflowDetailResponse> = {
        success: true,
        data: response,
        timestamp: new Date().toISOString(),
      };

      res.set("X-Validation-Status", validation.isValid ? "valid" : "invalid");
      res.set("X-Node-Count", totalNodes.toString());
      res.set("X-Total-Nodes", totalNodes.toString());
      if (hasPagination) {
        res.set("X-Returned-Nodes", paginatedNodes.length.toString());
        res.set("X-Has-More", hasMore.toString());
      }

      res.json(apiResponse);
    } catch (error) {
      // Handle specific error types from WorkflowService
      if (error instanceof Error) {
        if (error.message.includes("not found") || error.message.includes("Invalid")) {
          throw createApiError.notFound(`Workflow not found: ${reference}`);
        }
      }
      throw error;
    }
  }),
);

/**
 * GET /api/workflows/:id/raw - Get raw workflow JSON
 * Accepts UUID or slug as identifier
 */
router.get(
  "/:id/raw",
  validateParams({
    id: paramValidators.workflowId,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = (req as AuthenticatedRequest).userId;

    try {
      // Try by ID first, then by slug
      let workflowInfo = await repository.getWorkflow(id, userId);
      if (!workflowInfo || !workflowInfo.workflow) {
        const workflowBySlug = await workflowService.getBySlug(id, userId);
        if (workflowBySlug) {
          workflowInfo = await workflowService.getFullInfo(workflowBySlug.id, userId);
        }
      }
      if (!workflowInfo || !workflowInfo.workflow) {
        throw createApiError.notFound(`Workflow not found: ${id}`);
      }

      const workflow = workflowInfo.workflow;
      const fileInfo = {
        path: workflowInfo.storagePath,
        size: workflowInfo.size,
        lastModified: workflowInfo.updatedAt,
      };

      const response: RawWorkflowResponse = {
        raw: JSON.stringify(workflow, null, 2),
        parsed: workflow,
        fileInfo,
      };

      const apiResponse: ApiResponse<RawWorkflowResponse> = {
        success: true,
        data: response,
        timestamp: new Date().toISOString(),
      };

      res.json(apiResponse);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw createApiError.notFound(`Workflow not found: ${id}`);
      }
      throw error;
    }
  }),
);

/**
 * POST /api/workflows/:id/validate - Validate specific workflow
 * Accepts UUID or slug as identifier
 */
router.post(
  "/:id/validate",
  validateParams({
    id: paramValidators.workflowId,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const validationRequest: WorkflowValidationRequest = req.body;
    const userId = (req as AuthenticatedRequest).userId;

    const validationService = new WorkflowValidationService();

    let workflow: WorkflowGraph;

    try {
      if (validationRequest.workflowData) {
        // Validate provided workflow data
        workflow = validationRequest.workflowData;
      } else {
        // Validate workflow from repository - try by ID first, then by slug
        let workflowInfo = await repository.getWorkflow(id, userId);
        if (!workflowInfo || !workflowInfo.workflow) {
          const workflowBySlug = await workflowService.getBySlug(id, userId);
          if (workflowBySlug) {
            workflowInfo = await workflowService.getFullInfo(workflowBySlug.id, userId);
          }
        }
        if (!workflowInfo || !workflowInfo.workflow) {
          throw createApiError.notFound(`Workflow not found: ${id}`);
        }
        workflow = workflowInfo.workflow;
      }

      // Perform validation
      const validation = await validationService.validateWorkflow(workflow);
      const compatibility = await validationService.checkVisualizationCompatibility(workflow);

      // Create detailed validation response
      const nodeValidations: Record<
        string,
        { isValid: boolean; errors: string[]; warnings: string[]; suggestions: string[] }
      > = {};
      workflow.nodes.forEach((node: GraphNode) => {
        const nodeValidation = validation.nodeValidation[node.id] || {
          isValid: true,
          errors: [],
          warnings: [],
        };

        nodeValidations[node.id] = {
          ...nodeValidation,
          suggestions: compatibility.issues.filter((issue) => issue.includes(node.id)),
        };
      });

      const response: WorkflowValidationResponse = {
        validation,
        details: {
          isValid: validation.isValid && compatibility.isCompatible,
          errors: [...validation.globalErrors, ...compatibility.issues],
          warnings: [...validation.globalWarnings, ...compatibility.warnings],
        },
        nodeValidations,
      };

      const apiResponse: ApiResponse<WorkflowValidationResponse> = {
        success: true,
        data: response,
        timestamp: new Date().toISOString(),
      };

      res.set("X-Validation-Status", validation.isValid ? "valid" : "invalid");
      res.json(apiResponse);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw createApiError.notFound(`Workflow not found: ${id}`);
      }

      if (error instanceof SyntaxError) {
        throw createApiError.validationFailed("Invalid JSON format in workflow", {
          parseError: error.message,
        });
      }

      throw error;
    }
  }),
);

// NOTE: Upload/download token endpoints moved to workflow-tokens.ts (public router)
// These endpoints are now at /api/public/workflows/upload/:token and /api/public/workflows/download/:token
// Token-based endpoints should not be behind auth middleware - token itself is the authorization

/**
 * POST /api/workflows - Create new workflow
 * Size validation handled by repository layer (max 5MB)
 * Audit logging handled by WorkflowService
 * Supports optional slug parameter for human-readable URL
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const { id, slug, workflow, overwrite, visibility } = req.body;
    const userId = (req as AuthenticatedRequest).userId;

    if (!workflow) {
      throw createApiError.badRequest("Workflow object required");
    }

    if (!workflow.metadata) {
      throw createApiError.badRequest("Workflow metadata required (name, version, description)");
    }

    // Validate slug format if provided
    if (slug) {
      const slugValidation = validateSlug(slug);
      if (!slugValidation.valid) {
        throw createApiError.badRequest(`Invalid slug: ${slugValidation.error}`);
      }
    }

    const workflowId = id || workflow.id || `workflow-${Date.now()}`;
    const workflowVisibility = visibility || "private";

    // Check if exists
    const existing = await workflowService.get(workflowId, userId, true);
    if (existing && !overwrite) {
      throw createApiError.badRequest(
        `Workflow '${workflowId}' already exists. Use overwrite: true to replace.`,
      );
    }

    // Save workflow via service (handles validation caching automatically)
    // Issue #463: WorkflowService.save delegates to WorkflowMutationService
    // which validates and caches result, allowing invalid workflows to be saved
    const result = await workflowService.save({
      graph: { id: workflowId, ...workflow },
      userId,
      slug,
      visibility: workflowVisibility,
    });

    // Get validation result from mutation service (cached during save)
    const isValid = result.validation?.status === "valid";
    const validationErrors = result.validation?.errors || [];

    res.json({
      success: true,
      data: {
        workflowId: result.id,
        slug: result.slug,
        message: existing ? "Workflow updated" : "Workflow created",
        metadata: workflow.metadata,
        validation: {
          valid: isValid,
          status: result.validation?.status || "unknown",
          errors: validationErrors,
        },
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/workflows/:id - Soft delete workflow
 * Accepts UUID or slug as identifier
 * Audit logging handled by WorkflowService
 */
router.delete(
  "/:id",
  validateParams({ id: paramValidators.workflowId }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = (req as AuthenticatedRequest).userId;

    // Resolve identifier to actual workflow ID
    const workflowId = await resolveWorkflowId(id, userId);
    if (!workflowId) {
      throw createApiError.notFound(`Workflow not found: ${id}`);
    }

    // Soft delete workflow via service (handles audit automatically)
    const deleted = await workflowService.softDelete(workflowId, userId);

    if (!deleted) {
      throw createApiError.notFound(`Failed to delete workflow: ${id}`);
    }

    res.json({
      success: true,
      data: { workflowId, deleted: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/workflows/:id/copy - Copy workflow as template
 * Creates a private copy owned by current user
 * Accepts UUID or slug as identifier
 * Audit logging handled by WorkflowService
 */
router.post(
  "/:id/copy",
  validateParams({ id: paramValidators.workflowId }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { newName } = req.body;
    const userId = (req as AuthenticatedRequest).userId;

    // Get source workflow - try by ID first, then by slug
    let workflowInfo = await repository.getWorkflow(id, userId);
    if (!workflowInfo || !workflowInfo.workflow) {
      const workflowBySlug = await workflowService.getBySlug(id, userId);
      if (workflowBySlug) {
        workflowInfo = await workflowService.getFullInfo(workflowBySlug.id, userId);
      }
    }
    if (!workflowInfo || !workflowInfo.workflow) {
      throw createApiError.notFound(`Workflow not found: ${id}`);
    }

    const sourceWorkflow = workflowInfo.workflow;

    // Create deep copy with modified name
    // WorkflowService.save will generate UUID and slug automatically
    const copiedWorkflow: WorkflowGraph = JSON.parse(JSON.stringify(sourceWorkflow));
    copiedWorkflow.id = "temp-for-copy"; // Will be replaced by server-generated UUID
    copiedWorkflow.metadata = {
      ...copiedWorkflow.metadata,
      name: newName || `${sourceWorkflow.metadata.name} (copy)`,
    };

    // Save as private workflow owned by current user
    // Service generates UUID and slug automatically
    // Issue #463: Now includes validation caching
    const saveResult = await workflowService.save({
      graph: copiedWorkflow,
      userId,
      visibility: "private",
      isUpdate: false,
    });

    // Get validation result from mutation service (cached during save)
    const isValid = saveResult.validation?.status === "valid";
    const validationErrors = saveResult.validation?.errors || [];

    res.json({
      success: true,
      data: {
        workflowId: saveResult.id,
        slug: saveResult.slug,
        sourceWorkflowId: workflowInfo.id,
        message: `Workflow copied as '${saveResult.slug}'`,
        metadata: copiedWorkflow.metadata,
        visibility: "private",
        validation: {
          valid: isValid,
          status: saveResult.validation?.status || "unknown",
          errors: validationErrors,
        },
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PATCH /api/workflows/:id/visibility - Update workflow visibility
 * Only owner can change visibility
 * Accepts UUID or slug as identifier
 * Audit logging handled by WorkflowService
 */
router.patch(
  "/:id/visibility",
  validateParams({ id: paramValidators.workflowId }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { visibility } = req.body;
    const userId = (req as AuthenticatedRequest).userId;

    // Validate visibility value
    if (!visibility || !["public", "private"].includes(visibility)) {
      throw createApiError.badRequest("Invalid visibility value. Must be 'public' or 'private'");
    }

    // Resolve identifier to actual workflow ID
    const workflowId = await resolveWorkflowId(id, userId);
    if (!workflowId) {
      throw createApiError.notFound(`Workflow not found: ${id}`);
    }

    // Update visibility via service (handles audit automatically)
    const updated = await workflowService.updateVisibility(workflowId, userId, visibility);

    if (!updated) {
      throw createApiError.notFound(`Workflow not found or access denied: ${id}`);
    }

    res.json({
      success: true,
      data: { workflowId, visibility },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PATCH /api/workflows/:handle/:slug/visibility - Update workflow visibility by handle/slug
 * Only owner can change visibility
 * This is the canonical URL format for user-facing operations
 */
router.patch(
  "/:handle/:slug/visibility",
  asyncHandler(async (req: Request, res: Response) => {
    const { handle, slug } = req.params;
    const { visibility } = req.body;
    const userId = (req as AuthenticatedRequest).userId;

    // Validate handle and slug
    if (!handle || !slug) {
      throw createApiError.badRequest("Both handle and slug are required");
    }

    // Validate visibility value
    if (!visibility || !["public", "private"].includes(visibility)) {
      throw createApiError.badRequest("Invalid visibility value. Must be 'public' or 'private'");
    }

    // Construct reference and resolve to workflow ID
    const reference = `${handle}/${slug}`;
    const workflowId = await resolveWorkflowId(reference, userId);
    if (!workflowId) {
      throw createApiError.notFound(`Workflow not found: ${reference}`);
    }

    // Update visibility via service (handles audit automatically)
    const updated = await workflowService.updateVisibility(workflowId, userId, visibility);

    if (!updated) {
      throw createApiError.notFound(`Workflow not found or access denied: ${reference}`);
    }

    res.json({
      success: true,
      data: { workflowId, visibility },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/workflows/:handle/:slug - Delete workflow by handle/slug
 * Only owner can delete
 * This is the canonical URL format for user-facing operations
 */
router.delete(
  "/:handle/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const { handle, slug } = req.params;
    const userId = (req as AuthenticatedRequest).userId;

    // Validate handle and slug
    if (!handle || !slug) {
      throw createApiError.badRequest("Both handle and slug are required");
    }

    // Construct reference and resolve to workflow ID
    const reference = `${handle}/${slug}`;
    const workflowId = await resolveWorkflowId(reference, userId);
    if (!workflowId) {
      throw createApiError.notFound(`Workflow not found: ${reference}`);
    }

    // Soft delete workflow via service (handles audit automatically)
    const deleted = await workflowService.softDelete(workflowId, userId);

    if (!deleted) {
      throw createApiError.notFound(`Failed to delete workflow: ${reference}`);
    }

    res.json({
      success: true,
      data: { workflowId, deleted: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/workflows/:handle/:slug/copy - Copy workflow by handle/slug
 * Creates a private copy owned by current user
 * This is the canonical URL format for user-facing operations
 */
router.post(
  "/:handle/:slug/copy",
  asyncHandler(async (req: Request, res: Response) => {
    const { handle, slug } = req.params;
    const { newName } = req.body;
    const userId = (req as AuthenticatedRequest).userId;

    // Validate handle and slug
    if (!handle || !slug) {
      throw createApiError.badRequest("Both handle and slug are required");
    }

    // Get source workflow using handle/slug reference
    const reference = `${handle}/${slug}`;
    const { workflow: sourceWorkflow } = await workflowService.getByReference(reference, userId);
    if (!sourceWorkflow) {
      throw createApiError.notFound(`Workflow not found: ${reference}`);
    }

    // Get source workflow info for the response
    const sourceInfo = await workflowService.getBySlug(slug, userId);
    const sourceWorkflowId = sourceInfo?.id || reference;

    // Create deep copy with modified name
    // WorkflowService.save will generate UUID and slug automatically
    const copiedWorkflow: WorkflowGraph = JSON.parse(JSON.stringify(sourceWorkflow));
    copiedWorkflow.id = "temp-for-copy"; // Will be replaced by server-generated UUID
    copiedWorkflow.metadata = {
      ...copiedWorkflow.metadata,
      name: newName || `${sourceWorkflow.metadata.name} (copy)`,
    };

    // Save as private workflow owned by current user
    // Service generates UUID and slug automatically
    const saveResult = await workflowService.save({
      graph: copiedWorkflow,
      userId,
      visibility: "private",
      isUpdate: false,
    });

    res.json({
      success: true,
      data: {
        workflowId: saveResult.id,
        slug: saveResult.slug,
        sourceWorkflowId,
        message: `Workflow copied as '${saveResult.slug}'`,
        metadata: copiedWorkflow.metadata,
        visibility: "private",
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PATCH /api/workflows/:id/slug - Update workflow slug
 * Only owner can change slug
 * Accepts UUID or slug as identifier
 * Audit logging handled by WorkflowService
 */
router.patch(
  "/:id/slug",
  validateParams({ id: paramValidators.workflowId }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { slug } = req.body;
    const userId = (req as AuthenticatedRequest).userId;

    // Validate slug value
    if (!slug || typeof slug !== "string") {
      throw createApiError.badRequest("Slug is required and must be a string");
    }

    // Resolve identifier to actual workflow ID
    const workflowId = await resolveWorkflowId(id, userId);
    if (!workflowId) {
      throw createApiError.notFound(`Workflow not found: ${id}`);
    }

    // Update slug via service (handles validation and audit automatically)
    // Service throws InvalidSlugError or SlugConflictError on failure
    const success = await workflowService.updateSlug(workflowId, userId, slug);

    if (!success) {
      throw createApiError.notFound(`Workflow not found or access denied: ${id}`);
    }

    res.json({
      success: true,
      data: { workflowId, slug },
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as workflowRoutes };
