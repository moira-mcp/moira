/**
 * Public Workflow Token Routes
 * Upload/download workflows via temporary tokens (no auth middleware required)
 * Token itself provides authorization
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import { DatabaseRepository, WorkflowGraph } from "@mcp-moira/workflow-engine";
import { WorkflowValidationService } from "../services/validation-service.js";
import { TokenManager, createLogger, getWorkflowService } from "@mcp-moira/shared";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { checkAdminRole } from "../utils/admin-utils.js";

const router = Router();
const repository = new DatabaseRepository();
const logger = createLogger({ component: "WorkflowTokens" });

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

/**
 * POST /api/public/workflows/upload/:token - Upload workflow file via token
 * Public endpoint - token provides authorization
 */
router.post(
  "/upload/:token",
  upload.single("workflow"),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params;

    // Validate token
    const tokenManager = TokenManager.getInstance();
    const tokenData = tokenManager.validateToken(token, "upload");

    if (!tokenData) {
      throw createApiError.unauthorized("Invalid, expired, or already used token");
    }

    // Get userId from token (not from auth middleware)
    const userId = tokenData.userId;

    // Check file uploaded
    if (!req.file) {
      throw createApiError.validationFailed("No file uploaded");
    }

    // Parse JSON and extract slug (slug is not part of WorkflowGraph interface but present in JSON files)
    let workflowData: WorkflowGraph;
    let jsonSlug: string | undefined;
    try {
      const fileContent = req.file.buffer.toString("utf-8");
      const parsed = JSON.parse(fileContent);
      jsonSlug = typeof parsed.slug === "string" ? parsed.slug : undefined;
      workflowData = parsed as WorkflowGraph;
    } catch {
      throw createApiError.validationFailed("Invalid JSON format");
    }

    // Get visibility from form field (default: private)
    const visibilityParam = req.body.visibility;
    const visibility: "public" | "private" = visibilityParam === "public" ? "public" : "private";

    // Validate visibility parameter if provided
    if (visibilityParam && !["public", "private"].includes(visibilityParam)) {
      throw createApiError.validationFailed(
        "Invalid visibility value. Must be 'public' or 'private'",
      );
    }

    // Get forceNew from form field - if true, always create new workflow ignoring id in JSON
    const forceNewParam = req.body.forceNew;
    const forceNew = forceNewParam === "true" || forceNewParam === true;

    // If forceNew is true, remove id from workflow to force creation of new workflow
    // This allows users to create copies of public template workflows
    if (forceNew && workflowData.id) {
      logger.info("forceNew=true: removing workflow id to create copy", {
        originalId: workflowData.id,
        userId,
      });
      // Cast to allow deletion - server will generate new UUID
      (workflowData as { id?: string }).id = undefined;
    }

    // Get adminOverride from form field - if true, allows admin to update workflow owned by another user
    // SERVER-SIDE admin check: verify user is actually admin before allowing override
    const adminOverrideParam = req.body.adminOverride;
    const adminOverrideRequested = adminOverrideParam === "true" || adminOverrideParam === true;
    let adminBypass = false;

    if (adminOverrideRequested) {
      const isAdmin = await checkAdminRole(userId);
      if (!isAdmin) {
        throw createApiError.forbidden(
          "Admin override requires admin privileges. You are not an admin.",
        );
      }
      adminBypass = true;
      logger.info("adminOverride=true: admin is overriding ownership check", {
        workflowId: workflowData.id,
        adminUserId: userId,
      });
    }

    // Get workflow service (used for slug resolution and save)
    const workflowService = getWorkflowService();

    // Admin override: resolve slug to find existing public workflow's UUID
    // This ensures the save operation updates the existing workflow instead of creating a duplicate
    if (adminBypass && jsonSlug) {
      const existing = await workflowService.resolvePublicSlug(jsonSlug);
      if (existing) {
        logger.info("adminOverride: resolved slug to existing workflow", {
          slug: jsonSlug,
          existingId: existing.id,
          existingOwner: existing.ownerHandle,
          originalId: workflowData.id,
        });
        workflowData.id = existing.id;
      }
    }

    // Duplicate prevention (#498): reject non-admin uploads with slugs that conflict
    // with existing public workflows owned by other users
    if (!adminBypass && jsonSlug) {
      const existing = await workflowService.resolvePublicSlug(jsonSlug);
      if (existing && existing.userId !== userId) {
        throw createApiError.validationFailed(
          `Slug '${jsonSlug}' conflicts with an existing public workflow` +
            (existing.ownerHandle ? ` by ${existing.ownerHandle}` : "") +
            `. Choose a different slug or use forceNew=true to auto-generate one.`,
        );
      }
    }

    // Set temporary ID for validation if not provided (server generates final UUID)
    if (!workflowData.id) {
      workflowData.id = "temp-validation-id";
    }

    // Validate workflow structure
    const validationService = new WorkflowValidationService();
    const validation = await validationService.validateWorkflow(workflowData);

    if (!validation.isValid) {
      throw createApiError.validationFailed("Workflow validation failed", { validation });
    }

    // Save workflow via service (generates UUID automatically)
    let saveResult;
    try {
      saveResult = await workflowService.save({
        graph: workflowData,
        userId,
        slug: jsonSlug,
        visibility,
        adminBypass,
      });
    } catch (saveError) {
      // Enhance "Access denied" error with helpful hints about forceNew and adminOverride
      const errorMessage = saveError instanceof Error ? saveError.message : String(saveError);
      if (
        errorMessage.includes("Access denied") &&
        errorMessage.includes("owned by another user")
      ) {
        const workflowId = workflowData.id !== "temp-validation-id" ? workflowData.id : "unknown";
        throw createApiError.forbidden(
          `Access denied: you cannot modify workflow '${workflowId}' owned by another user.\n\n` +
            `Hint: This workflow belongs to another user. To create your own copy:\n` +
            `  - Use forceNew=true parameter to create a new workflow with new ID\n\n` +
            `For administrators only:\n` +
            `  - Use adminOverride=true parameter to overwrite the original workflow`,
        );
      }
      // Re-throw other errors unchanged
      throw saveError;
    }

    // Mark token as used
    tokenManager.markTokenAsUsed(token);

    res.json({
      success: true,
      data: {
        workflowId: saveResult.id,
        slug: saveResult.slug,
        uploaded: true,
        nodeCount: workflowData.nodes.length,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/public/workflows/download/:token - Download workflow as file via token
 * Public endpoint - token provides authorization
 */
router.get(
  "/download/:token",
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params;

    logger.debug("Download request received", { tokenPrefix: token.substring(0, 20) });

    // Validate token
    const tokenManager = TokenManager.getInstance();
    const tokenData = tokenManager.validateToken(token, "download");

    logger.debug("Token validation result", { valid: !!tokenData });

    if (!tokenData) {
      throw createApiError.unauthorized("Invalid, expired, or already used token");
    }

    // Get userId and workflowId from token
    const { userId, workflowId } = tokenData;

    // Get workflow (workflowId guaranteed non-null by tokenData check above)
    const workflow = await repository.getWorkflowGraph(workflowId!, userId);

    if (!workflow) {
      throw createApiError.notFound("Workflow not found", { workflowId });
    }

    // Mark token as used
    tokenManager.markTokenAsUsed(token);

    // Send as formatted JSON file download (2 spaces indent for readability)
    const filename = `${workflowId}.json`;
    const formattedJson = JSON.stringify(workflow, null, 2);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(formattedJson);
  }),
);

export { router as workflowTokenRoutes };
