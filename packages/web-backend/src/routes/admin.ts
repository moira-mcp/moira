/**
 * Admin API Routes
 * Admin-only endpoints for system management
 */

import { Router, Request, Response } from "express";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { requireAdmin } from "../middleware/admin-middleware.js";
import {
  sendEmail,
  isEmailConfigured,
  logAuditEvent,
  AuditAction,
  getBaseUrl,
  getDbPath,
  getGlobalSettingsService,
  getMcpTextService,
  getArtifactService,
  getArtifactUrl,
  getLockService,
  MCP_TEXT_KEYS,
  MCP_AGENT_CATEGORY,
  MCP_MODEL_CATEGORY,
} from "@mcp-moira/shared";

const router = Router();
const repository = new DatabaseRepository();

// All admin routes protected by requireAdmin middleware
router.use(requireAdmin);

/**
 * GET /api/admin/settings/definitions - List all setting definitions (including adminOnly)
 * Query params: category (optional)
 */
router.get(
  "/settings/definitions",
  asyncHandler(async (req: Request, res: Response) => {
    const { category } = req.query;

    const definitions = await repository.getSettingDefinitions(category as string);

    res.json({
      success: true,
      data: definitions,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/settings/definitions - Create setting definition
 */
router.post(
  "/settings/definitions",
  asyncHandler(async (req: Request, res: Response) => {
    const definition = req.body;

    // Validate required fields
    if (!definition.key || !definition.type || !definition.category || !definition.label) {
      throw createApiError.validationFailed("Missing required fields: key, type, category, label");
    }

    // Create definition via repository
    await repository.createSettingDefinition({
      key: definition.key,
      type: definition.type,
      category: definition.category,
      label: definition.label,
      description: definition.description || null,
      defaultValue: definition.defaultValue || null,
      required: definition.required || false,
      validation: definition.validation || null,
      adminOnly: definition.adminOnly || false,
      protected: definition.protected || false,
    });

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_SETTINGS_CREATE_DEFINITION,
      resource: "settingDefinition",
      resourceId: definition.key,
      metadata: { key: definition.key, type: definition.type },
    });

    res.json({
      success: true,
      data: { key: definition.key, created: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PUT /api/admin/settings/definitions/:key - Update setting definition
 */
router.put(
  "/settings/definitions/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;
    const updates = req.body;

    // Get existing definition
    const existing = await repository.getSettingDefinition(key);
    if (!existing) {
      throw createApiError.notFound(`Setting definition not found: ${key}`, { key });
    }

    // Delete and recreate with updates (no update method in repository)
    await repository.deleteSettingDefinition(key);
    await repository.createSettingDefinition({
      key,
      type: updates.type || existing.type,
      category: updates.category || existing.category,
      label: updates.label || existing.label,
      description: updates.description !== undefined ? updates.description : existing.description,
      defaultValue:
        updates.defaultValue !== undefined ? updates.defaultValue : existing.defaultValue,
      required: updates.required !== undefined ? updates.required : existing.required,
      validation: updates.validation !== undefined ? updates.validation : existing.validation,
      adminOnly: updates.adminOnly !== undefined ? updates.adminOnly : existing.adminOnly,
      protected: updates.protected !== undefined ? updates.protected : existing.protected,
    });

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_SETTINGS_UPDATE_DEFINITION,
      resource: "settingDefinition",
      resourceId: key,
      metadata: { key },
    });

    res.json({
      success: true,
      data: { key, updated: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/settings/definitions/:key - Delete setting definition
 */
router.delete(
  "/settings/definitions/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;

    // Delete definition (cascades to user values)
    // Repository will throw error if definition is protected
    await repository.deleteSettingDefinition(key);

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_SETTINGS_DELETE_DEFINITION,
      resource: "settingDefinition",
      resourceId: key,
      metadata: { key },
    });

    res.json({
      success: true,
      data: { key, deleted: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/settings/definitions/export - Export all setting definitions (schema)
 */
router.get(
  "/settings/definitions/export",
  asyncHandler(async (req: Request, res: Response) => {
    const definitions = await repository.getSettingDefinitions();

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_SETTINGS_EXPORT_SCHEMA,
      resource: "settingDefinition",
      resourceId: "all",
      metadata: { count: definitions.length },
    });

    const exportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      definitions: definitions.map((def) => ({
        key: def.key,
        type: def.type,
        category: def.category,
        label: def.label,
        description: def.description,
        defaultValue: def.defaultValue,
        required: def.required,
        validation: def.validation,
        adminOnly: def.adminOnly,
        protected: def.protected,
      })),
    };

    res.json({
      success: true,
      data: exportData,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/users - List all users
 * Query params: search, limit, offset
 */
router.get(
  "/users",
  asyncHandler(async (req: Request, res: Response) => {
    const search = req.query.search as string | undefined;
    const sort = req.query.sort as string | undefined;
    const sortOrder = req.query.sortOrder as "asc" | "desc" | undefined;
    const limit = parseInt(req.query.limit as string) || undefined;
    const offset = parseInt(req.query.offset as string) || undefined;

    const { getDatabase, UserRepository } = await import("@mcp-moira/shared");
    const db = getDatabase();
    const userRepo = new UserRepository(db);

    const result = await userRepo.listAdmin({
      search,
      sort: sort as "email" | "name" | "createdAt" | undefined,
      sortOrder,
      limit,
      offset,
    });

    res.json({
      success: true,
      data: { users: result.users, total: result.total, limit: limit ?? 20, offset: offset ?? 0 },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/users/:id - Get user details
 */
router.get(
  "/users/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const { user, session, emailLog, getDatabase } = await import("@mcp-moira/shared");
    const { eq, desc } = await import("drizzle-orm");
    const db = getDatabase();

    // Get user
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Get sessions
    const sessions = await db
      .select({
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })
      .from(session)
      .where(eq(session.userId, id));

    // Get email history
    const emails = await db
      .select()
      .from(emailLog)
      .where(eq(emailLog.userId, id))
      .orderBy(desc(emailLog.createdAt))
      .limit(50);

    // Get workflow count
    const workflows = await repository.listWorkflows(id);

    // Get blockedBy admin name if user is blocked
    let blockedByName: string | null = null;
    if (userData.blockedBy) {
      const [blockedByUser] = await db
        .select({
          name: user.name,
          email: user.email,
        })
        .from(user)
        .where(eq(user.id, userData.blockedBy))
        .limit(1);
      blockedByName = blockedByUser?.name || blockedByUser?.email || null;
    }

    res.json({
      success: true,
      data: {
        user: {
          id: userData.id,
          email: userData.email,
          name: userData.name,
          isAdmin: userData.isAdmin,
          emailVerified: userData.emailVerified,
          blocked: userData.blocked,
          blockedAt: userData.blockedAt,
          blockedReason: userData.blockedReason,
          blockedBy: userData.blockedBy,
          blockedByName,
          passwordResetRequired: userData.passwordResetRequired,
          passwordResetRequestedAt: userData.passwordResetRequestedAt,
          passwordResetRequestedBy: userData.passwordResetRequestedBy,
          createdAt: userData.createdAt,
          updatedAt: userData.updatedAt,
        },
        stats: {
          workflowsCount: workflows.length,
          sessionsCount: sessions.length,
          emailsCount: emails.length,
        },
        sessions,
        emails,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/users/:id/block - Block user and revoke all sessions
 */
router.post(
  "/users/:id/block",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { reason } = req.body;

    // Prevent admin from blocking themselves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    if (id === currentUserId) {
      throw createApiError.badRequest("Cannot block your own account");
    }

    const { user, session, oauthAccessToken, oauthConsent, getDatabase } =
      await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Check user exists
    const [existing] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!existing) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Block user
    await db
      .update(user)
      .set({
        blocked: true,
        blockedAt: new Date().toISOString(),
        blockedReason: reason || null,
        blockedBy: currentUserId,
      })
      .where(eq(user.id, id));

    // Revoke all sessions, OAuth tokens, and OAuth consents
    const deletedSessions = await db.delete(session).where(eq(session.userId, id)).returning();
    const deletedOAuthTokens = await db
      .delete(oauthAccessToken)
      .where(eq(oauthAccessToken.userId, id))
      .returning();
    const deletedOAuthConsents = await db
      .delete(oauthConsent)
      .where(eq(oauthConsent.userId, id))
      .returning();

    // Audit logging
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_BLOCK_USER,
      resource: "user",
      resourceId: id,
      metadata: {
        reason,
        revokedSessions: deletedSessions.length,
        revokedOAuthTokens: deletedOAuthTokens.length,
        revokedOAuthConsents: deletedOAuthConsents.length,
      },
    });

    res.json({
      success: true,
      data: {
        id,
        blocked: true,
        revokedSessions: deletedSessions.length,
        revokedOAuthTokens: deletedOAuthTokens.length,
        revokedOAuthConsents: deletedOAuthConsents.length,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/users/:id/unblock - Unblock user
 */
router.post(
  "/users/:id/unblock",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const { user, getDatabase } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Check user exists
    const [existing] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!existing) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Unblock user
    await db
      .update(user)
      .set({
        blocked: false,
        blockedAt: null,
        blockedReason: null,
        blockedBy: null,
      })
      .where(eq(user.id, id));

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_UNBLOCK_USER,
      resource: "user",
      resourceId: id,
    });

    res.json({
      success: true,
      data: { id, unblocked: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/users/:id/verify-email - Directly verify user's email (no email sent)
 */
router.post(
  "/users/:id/verify-email",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const { user, getDatabase } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Get user
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Set emailVerified to true
    await db
      .update(user)
      .set({
        emailVerified: true,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(user.id, id));

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_VERIFY_EMAIL,
      resource: "user",
      resourceId: id,
    });

    res.json({
      success: true,
      data: { id, emailVerified: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/users/:id/send-verification - Send verification email
 */
router.post(
  "/users/:id/send-verification",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!isEmailConfigured()) {
      throw createApiError.badRequest("Email service not configured");
    }

    const { user, getDatabase } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Get user
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Generate verification token and URL
    const token = crypto.randomUUID();
    const url = `${getBaseUrl()}/api/auth/verify-email?token=${token}`;

    // Store verification token
    const { verification } = await import("@mcp-moira/shared");
    await db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: userData.email,
      value: token,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Send email
    await sendEmail(id, "verification", {
      to: userData.email,
      subject: "Verify your email - MCP Moira",
      text: `Click the link to verify your email: ${url}`,
      html: `
      <h2>Verify Your Email</h2>
      <p>Click the button below to verify your email address:</p>
      <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#10b981;color:white;text-decoration:none;border-radius:6px;">Verify Email</a></p>
      <p>Or copy this link: ${url}</p>
    `,
    });

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_SEND_VERIFICATION,
      resource: "user",
      resourceId: id,
    });

    res.json({
      success: true,
      data: { id, emailSent: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/users/:id/send-reset - Send password reset email
 */
router.post(
  "/users/:id/send-reset",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    if (!isEmailConfigured()) {
      throw createApiError.badRequest("Email service not configured");
    }

    const { user, getDatabase } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Get user
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Generate reset token and URL
    const token = crypto.randomUUID();
    const url = `${getBaseUrl()}/reset-password?token=${token}`;

    // Store reset token
    const { verification } = await import("@mcp-moira/shared");
    await db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: userData.email,
      value: token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Send email
    await sendEmail(id, "password_reset", {
      to: userData.email,
      subject: "Reset your password - MCP Moira",
      text: `Click the link to reset your password: ${url}\n\nThis link will expire in 1 hour.`,
      html: `
      <h2>Reset Your Password</h2>
      <p>Click the button below to reset your password:</p>
      <p><a href="${url}" style="display:inline-block;padding:12px 24px;background:#3b82f6;color:white;text-decoration:none;border-radius:6px;">Reset Password</a></p>
      <p>Or copy this link: ${url}</p>
      <p><small>This link will expire in 1 hour.</small></p>
    `,
    });

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_SEND_RESET,
      resource: "user",
      resourceId: id,
    });

    res.json({
      success: true,
      data: { id, emailSent: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/emails - List all emails
 */
router.get(
  "/emails",
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, type, status } = req.query;

    const { emailLog, user, getDatabase } = await import("@mcp-moira/shared");
    const { eq, desc, and } = await import("drizzle-orm");
    const db = getDatabase();

    // Build query conditions
    const conditions = [];
    if (userId && typeof userId === "string") {
      conditions.push(eq(emailLog.userId, userId));
    }
    if (type && typeof type === "string") {
      conditions.push(eq(emailLog.type, type));
    }
    if (status && typeof status === "string") {
      conditions.push(eq(emailLog.status, status));
    }

    // Get emails with user info
    let query = db
      .select({
        id: emailLog.id,
        userId: emailLog.userId,
        type: emailLog.type,
        to: emailLog.to,
        subject: emailLog.subject,
        messageId: emailLog.messageId,
        status: emailLog.status,
        error: emailLog.error,
        createdAt: emailLog.createdAt,
      })
      .from(emailLog);

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }

    const emails = await query.orderBy(desc(emailLog.createdAt)).limit(100);

    // Get user emails for enrichment
    const users = await db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
      })
      .from(user);

    const userMap = new Map(users.map((u) => [u.id, { email: u.email, name: u.name }]));

    const enrichedEmails = emails.map((e) => ({
      ...e,
      userEmail: userMap.get(e.userId)?.email || "Unknown",
      userName: userMap.get(e.userId)?.name || null,
    }));

    res.json({
      success: true,
      data: enrichedEmails,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/stats - System statistics
 */
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const fs = await import("fs/promises");

    // Get counts from repository
    const workflows = await repository.listWorkflows("system-admin"); // Admin sees all
    const executions = await repository.listExecutions();
    const definitions = await repository.getSettingDefinitions();

    // Count active executions (Issue #386: only "running" status for active)
    const activeExecutions = executions.filter((e) => e.status === "running").length;

    // System health indicators
    const dbPath = getDbPath();
    let databaseSize = 0;
    try {
      const stats = await fs.stat(dbPath);
      databaseSize = stats.size;
    } catch (err) {
      // DB file not found or error
    }

    // Recent activity (last 10 executions)
    const recentActivity = executions
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 10)
      .map((e) => ({
        id: e.executionId,
        workflowId: e.workflowId,
        status: e.status,
        timestamp: e.createdAt,
        action: `Workflow execution ${e.status}`,
      }));

    res.json({
      success: true,
      data: {
        totalWorkflows: workflows.length,
        totalExecutions: executions.length,
        totalDefinitions: definitions.length,
        activeExecutions,
        systemHealth: {
          backendStatus: "healthy",
          databaseSize: databaseSize,
        },
        recentActivity,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PUT /api/admin/users/:id - Update user
 */
router.put(
  "/users/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { name, isAdmin, passwordResetRequired } = req.body;

    const { user, getDatabase } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Check user exists
    const existing = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (existing.length === 0) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Prevent admin from removing their own admin status
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    if (id === currentUserId && isAdmin === false) {
      throw createApiError.badRequest("Cannot remove your own admin status");
    }

    // Update user
    const updates: {
      name?: string;
      isAdmin?: boolean;
      passwordResetRequired?: boolean;
      passwordResetRequestedAt?: string | null;
      passwordResetRequestedBy?: string | null;
    } = {};
    if (name !== undefined) updates.name = name;
    if (isAdmin !== undefined) updates.isAdmin = isAdmin;
    if (passwordResetRequired !== undefined) {
      updates.passwordResetRequired = passwordResetRequired;
      // Clear related fields when resetting the flag
      if (passwordResetRequired === false) {
        updates.passwordResetRequestedAt = null;
        updates.passwordResetRequestedBy = null;
      }
    }

    await db.update(user).set(updates).where(eq(user.id, id));

    // Audit logging
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_UPDATE_USER,
      resource: "user",
      resourceId: id,
      metadata: { fields: Object.keys(updates) },
    });

    res.json({
      success: true,
      data: { id, updated: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/users/:id - Delete user
 */
router.delete(
  "/users/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    // Prevent admin from deleting themselves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    if (id === currentUserId) {
      throw createApiError.badRequest("Cannot delete your own account");
    }

    const { user, getDatabase } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Get user email for audit
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    const userEmail = userData?.email || "unknown";

    // Delete user (cascades to workflows and settings)
    await db.delete(user).where(eq(user.id, id));

    // Audit logging
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_DELETE_USER,
      resource: "user",
      resourceId: id,
      metadata: { email: userEmail },
    });

    res.json({
      success: true,
      data: { id, deleted: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/workflows - List ALL workflows across all users
 * Query params: search, userId, visibility, isValid, fromDate, toDate, sort, sortOrder, limit, offset
 */
router.get(
  "/workflows",
  asyncHandler(async (req: Request, res: Response) => {
    const search = req.query.search as string | undefined;
    const userId = req.query.userId as string | undefined;
    const visibility = req.query.visibility as "public" | "private" | "all" | undefined;
    const sort = req.query.sort as "createdAt" | "updatedAt" | "name" | undefined;
    const sortOrder = req.query.sortOrder as "asc" | "desc" | undefined;
    const limit = parseInt(req.query.limit as string) || undefined;
    const offset = parseInt(req.query.offset as string) || undefined;
    const fromDate = parseInt(req.query.fromDate as string) || undefined;
    const toDate = parseInt(req.query.toDate as string) || undefined;

    // Parse isValid: "true" → true, "false" → false, "unknown" → null, undefined → skip
    let isValid: boolean | null | undefined;
    const isValidParam = req.query.isValid as string | undefined;
    if (isValidParam === "true") isValid = true;
    else if (isValidParam === "false") isValid = false;
    else if (isValidParam === "unknown") isValid = null;

    const result = await repository.listAllWorkflowsPaginated({
      search,
      userId,
      visibility,
      isValid,
      fromDate,
      toDate,
      sort,
      sortOrder,
      limit,
      offset,
    });

    res.json({
      success: true,
      data: {
        workflows: result.workflows,
        total: result.total,
        limit: limit ?? 20,
        offset: offset ?? 0,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/workflows/deleted - List deleted workflows
 * Query params: search, sort, sortOrder, limit, offset
 */
router.get(
  "/workflows/deleted",
  asyncHandler(async (req: Request, res: Response) => {
    const search = req.query.search as string | undefined;
    const sort = req.query.sort as string | undefined;
    const sortOrder = req.query.sortOrder as "asc" | "desc" | undefined;
    const limit = parseInt(req.query.limit as string) || undefined;
    const offset = parseInt(req.query.offset as string) || undefined;

    const { items, total } = await repository.listAllDeletedWorkflowsPaginated({
      search,
      sort: sort as "name" | "deletedAt" | undefined,
      sortOrder,
      limit,
      offset,
    });

    // Enrich deletedBy userId with email
    const { user, getDatabase } = await import("@mcp-moira/shared");
    const db = getDatabase();
    const users = await db.select({ id: user.id, email: user.email }).from(user);
    const userMap = new Map(users.map((u) => [u.id, u.email]));

    const enriched = items.map((wf) => ({
      ...wf,
      deletedBy: wf.deletedBy ? userMap.get(wf.deletedBy) || wf.deletedBy : null,
    }));

    res.json({
      success: true,
      data: { workflows: enriched, total, limit: limit ?? 20, offset: offset ?? 0 },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/workflows/:id/restore - Restore deleted workflow
 */
router.post(
  "/workflows/:id/restore",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId || "system-admin";

    await repository.restoreWorkflow(id, currentUserId);

    // Audit logging
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.WORKFLOW_RESTORE,
      resource: "workflow",
      resourceId: id,
    });

    res.json({
      success: true,
      data: { workflowId: id, restored: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/workflows/:id/hard-delete - Permanently delete workflow
 */
router.delete(
  "/workflows/:id/hard-delete",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId || "system-admin";

    // Hard delete = permanent deletion
    await repository.deleteWorkflow(id, currentUserId);

    // Audit logging
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.WORKFLOW_HARD_DELETE,
      resource: "workflow",
      resourceId: id,
    });

    res.json({
      success: true,
      data: { workflowId: id, deleted: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/executions/:id/context - Get execution context
 */
router.get(
  "/executions/:id/context",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const execution = await repository.getExecution(id);
    if (!execution) {
      throw createApiError.notFound(`Execution not found: ${id}`, { executionId: id });
    }

    res.json({
      success: true,
      data: {
        executionId: execution.executionId,
        workflowId: execution.workflowId,
        userId: execution.userId,
        status: execution.status,
        currentNodeId: execution.currentNodeId,
        waitingForInputNodeId: execution.waitingForInputNodeId,
        context: {
          variables: execution.globalContext.variables,
          nodeStates: execution.globalContext.nodeStates,
        },
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt,
        completedAt: execution.completedAt,
        error: execution.error,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PUT /api/admin/executions/:id/context - Update execution context
 */
router.put(
  "/executions/:id/context",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { variables, nodeStates } = req.body;

    const execution = await repository.getExecution(id);
    if (!execution) {
      throw createApiError.notFound(`Execution not found: ${id}`, { executionId: id });
    }

    // Validate execution state - can only edit running executions (Issue #386: "waiting" merged into "running")
    if (execution.status !== "running") {
      throw createApiError.badRequest(
        `Cannot edit execution in state '${execution.status}'. Only 'running' executions can be edited.`,
        { executionId: id, status: execution.status },
      );
    }

    // Update context
    if (variables) {
      execution.globalContext.variables = {
        ...execution.globalContext.variables,
        ...variables,
      };
    }

    if (nodeStates) {
      execution.globalContext.nodeStates = {
        ...execution.globalContext.nodeStates,
        ...nodeStates,
      };
    }

    await repository.saveExecution(execution);

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_UPDATE_EXECUTION_CONTEXT,
      resource: "execution",
      resourceId: id,
      metadata: {
        variables: Object.keys(variables || {}),
        nodeStates: Object.keys(nodeStates || {}),
      },
    });

    res.json({
      success: true,
      data: { executionId: id, updated: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/database/vacuum - Vacuum database
 */
router.post(
  "/database/vacuum",
  asyncHandler(async (req: Request, res: Response) => {
    // Vacuum via repository (uses underlying SQLite instance)
    await repository.vacuum();

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_VACUUM_DB,
      resource: "database",
      resourceId: "moira",
    });

    res.json({
      success: true,
      data: { message: "Database vacuumed successfully" },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/database/backup - Download database backup
 * Returns binary SQLite file with Content-Disposition for auto-download
 */
router.post(
  "/database/backup",
  asyncHandler(async (req: Request, res: Response) => {
    const fs = await import("fs");
    const path = await import("path");
    const dbPath = getDbPath();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFilename = `moira-backup-${timestamp}.db`;
    const tempBackupPath = path.join(path.dirname(dbPath), `.backup-temp-${Date.now()}.db`);

    try {
      // WAL checkpoint before backup to ensure all data is written
      const { getSqliteInstance } = await import("@mcp-moira/shared");
      const db = getSqliteInstance();
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

      // Create backup using SQLite backup API
      await repository.backup(tempBackupPath);

      // Audit logging
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currentUserId = (req as any).user?.userId;
      await logAuditEvent(repository, req, {
        userId: currentUserId,
        action: AuditAction.ADMIN_BACKUP_DB,
        resource: "database",
        resourceId: "moira",
        metadata: { filename: backupFilename },
      });

      // Get file stats for Content-Length
      const stats = fs.statSync(tempBackupPath);

      // Set headers for file download
      res.setHeader("Content-Type", "application/x-sqlite3");
      res.setHeader("Content-Disposition", `attachment; filename="${backupFilename}"`);
      res.setHeader("Content-Length", stats.size);

      // Stream file to response
      const fileStream = fs.createReadStream(tempBackupPath);
      fileStream.pipe(res);

      // Cleanup temp file after streaming completes
      fileStream.on("end", () => {
        fs.unlink(tempBackupPath, () => {
          // Ignore cleanup errors
        });
      });

      fileStream.on("error", () => {
        fs.unlink(tempBackupPath, () => {
          // Ignore cleanup errors
        });
      });
    } catch (error) {
      // Cleanup on error
      const fs2 = await import("fs");
      fs2.unlink(tempBackupPath, () => {});
      throw error;
    }
  }),
);

/**
 * GET /api/admin/global-settings - List all global settings
 */
router.get(
  "/global-settings",
  asyncHandler(async (_req: Request, res: Response) => {
    const globalSettingsService = getGlobalSettingsService();

    const settings = await globalSettingsService.getAll();

    // Group by category for UI
    const grouped = settings.reduce(
      (acc, setting) => {
        if (!acc[setting.category]) {
          acc[setting.category] = [];
        }
        acc[setting.category].push(setting);
        return acc;
      },
      {} as Record<string, typeof settings>,
    );

    res.json({
      success: true,
      data: {
        settings,
        grouped,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PUT /api/admin/global-settings/:key - Update global setting value
 */
router.put(
  "/global-settings/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;
    const { value } = req.body;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    const globalSettingsService = getGlobalSettingsService();

    // Check setting exists
    const existing = await globalSettingsService.get(key);
    if (!existing) {
      throw createApiError.notFound(`Global setting not found: ${key}`, { key });
    }

    // Update value (audit logging is automatic in service)
    await globalSettingsService.setValue(key, value, currentUserId);

    res.json({
      success: true,
      data: { key, updated: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/global-settings/:key - Reset global setting to default (set value to null)
 * Used to deactivate agent/model prompt overrides
 */
router.delete(
  "/global-settings/:key",
  asyncHandler(async (req: Request, res: Response) => {
    const { key } = req.params;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    const globalSettingsService = getGlobalSettingsService();

    // Check setting exists
    const existing = await globalSettingsService.get(key);
    if (!existing) {
      throw createApiError.notFound(`Global setting not found: ${key}`, { key });
    }

    // Reset to null (deactivates override)
    await globalSettingsService.setValue(key, null, currentUserId);

    // Audit logging
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_GLOBAL_SETTINGS_RESET,
      resource: "globalSetting",
      resourceId: key,
      metadata: { previousValue: existing.value ? "(had value)" : "(was null)" },
    });

    res.json({
      success: true,
      data: { key, reset: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/global-settings/get-scope-value - Get raw value at specific scope (no fallback)
 * Returns the raw value stored at a specific scope level (default, agent, or model)
 * Used by MCP Prompts Editor to load values for editing
 *
 * Body: { promptType: string, vendor: "default"|"claude"|"chatgpt"|"gemini"|"cursor", model?: string }
 * promptType: "systemPrompt" | "systemReminder" | "toolDescription.{toolName}"
 */
router.post(
  "/global-settings/get-scope-value",
  asyncHandler(async (req: Request, res: Response) => {
    const { promptType, vendor, model } = req.body;

    if (!promptType) {
      throw createApiError.validationFailed("promptType is required");
    }
    if (!vendor) {
      throw createApiError.validationFailed("vendor is required");
    }

    const globalSettingsService = getGlobalSettingsService();

    // Parse promptType to get the type and optional toolName
    let settingKey: string;
    const isDefault = vendor === "default";

    if (promptType === "systemPrompt") {
      if (isDefault) {
        settingKey = MCP_TEXT_KEYS.systemPrompt;
      } else if (model) {
        settingKey = MCP_TEXT_KEYS.modelSystemPrompt(vendor, model);
      } else {
        settingKey = MCP_TEXT_KEYS.agentSystemPrompt(vendor);
      }
    } else if (promptType === "systemReminder") {
      if (isDefault) {
        settingKey = MCP_TEXT_KEYS.systemReminder;
      } else if (model) {
        settingKey = MCP_TEXT_KEYS.modelSystemReminder(vendor, model);
      } else {
        settingKey = MCP_TEXT_KEYS.agentSystemReminder(vendor);
      }
    } else if (promptType.startsWith("toolDescription.")) {
      const toolName = promptType.replace("toolDescription.", "");
      if (isDefault) {
        settingKey = MCP_TEXT_KEYS.toolDescription(toolName);
      } else if (model) {
        settingKey = MCP_TEXT_KEYS.modelToolDescription(vendor, model, toolName);
      } else {
        settingKey = MCP_TEXT_KEYS.agentToolDescription(vendor, toolName);
      }
    } else {
      throw createApiError.validationFailed(
        "Invalid promptType. Must be systemPrompt, systemReminder, or toolDescription.{toolName}",
      );
    }

    // Get raw value (may not exist for override keys)
    const setting = await globalSettingsService.get(settingKey);

    res.json({
      success: true,
      data: {
        key: settingKey,
        value: setting?.value ?? null,
        exists: !!setting,
        scope: isDefault ? "default" : model ? "model" : "agent",
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/global-settings/set-scope-value - Set value at specific scope
 * Sets the raw value at a specific scope level (default, agent, or model)
 * Used by MCP Prompts Editor to save values
 *
 * Body: { promptType: string, vendor: "default"|"claude"|"chatgpt"|"gemini"|"cursor", model?: string, value: string|null }
 */
router.post(
  "/global-settings/set-scope-value",
  asyncHandler(async (req: Request, res: Response) => {
    const { promptType, vendor, model, value } = req.body;

    if (!promptType) {
      throw createApiError.validationFailed("promptType is required");
    }
    if (!vendor) {
      throw createApiError.validationFailed("vendor is required");
    }

    // Validate vendor is one of the allowed values
    const VALID_VENDORS = ["default", "claude", "chatgpt", "gemini", "cursor"] as const;
    if (!VALID_VENDORS.includes(vendor)) {
      throw createApiError.validationFailed(
        `Invalid vendor: ${vendor}. Must be one of: ${VALID_VENDORS.join(", ")}`,
      );
    }

    // Validate promptType format
    const VALID_PROMPT_TYPES = ["systemPrompt", "systemReminder"] as const;
    const VALID_TOOL_NAMES = [
      "list",
      "start",
      "step",
      "manage",
      "help",
      "settings",
      "token",
      "session",
    ] as const;

    let validatedToolName: string | undefined;
    if (promptType.startsWith("toolDescription.")) {
      validatedToolName = promptType.replace("toolDescription.", "");
      if (!VALID_TOOL_NAMES.includes(validatedToolName as (typeof VALID_TOOL_NAMES)[number])) {
        throw createApiError.validationFailed(
          `Invalid tool name: ${validatedToolName}. Must be one of: ${VALID_TOOL_NAMES.join(", ")}`,
        );
      }
    } else if (!VALID_PROMPT_TYPES.includes(promptType as (typeof VALID_PROMPT_TYPES)[number])) {
      throw createApiError.validationFailed(
        `Invalid promptType: ${promptType}. Must be systemPrompt, systemReminder, or toolDescription.{toolName}`,
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    const globalSettingsService = getGlobalSettingsService();

    // Parse promptType to get the setting key
    let settingKey: string;
    const isDefault = vendor === "default";

    if (promptType === "systemPrompt") {
      if (isDefault) {
        settingKey = MCP_TEXT_KEYS.systemPrompt;
      } else if (model) {
        settingKey = MCP_TEXT_KEYS.modelSystemPrompt(vendor, model);
      } else {
        settingKey = MCP_TEXT_KEYS.agentSystemPrompt(vendor);
      }
    } else if (promptType === "systemReminder") {
      if (isDefault) {
        settingKey = MCP_TEXT_KEYS.systemReminder;
      } else if (model) {
        settingKey = MCP_TEXT_KEYS.modelSystemReminder(vendor, model);
      } else {
        settingKey = MCP_TEXT_KEYS.agentSystemReminder(vendor);
      }
    } else {
      // toolDescription.{toolName} - already validated above
      const toolName = validatedToolName!;
      if (isDefault) {
        settingKey = MCP_TEXT_KEYS.toolDescription(toolName);
      } else if (model) {
        settingKey = MCP_TEXT_KEYS.modelToolDescription(vendor, model, toolName);
      } else {
        settingKey = MCP_TEXT_KEYS.agentToolDescription(vendor, toolName);
      }
    }

    // Check if setting exists
    const existing = await globalSettingsService.get(settingKey);

    if (!existing) {
      // For default scope, setting must exist (created by seed script)
      if (isDefault) {
        throw createApiError.notFound(`Setting not found: ${settingKey}`, { key: settingKey });
      }

      // For agent/model overrides, create the setting dynamically if it doesn't exist
      // and value is non-null (null means "no override" - no need to create)
      if (value !== null && value !== undefined && value !== "") {
        const category = model ? MCP_MODEL_CATEGORY : MCP_AGENT_CATEGORY;

        // Generate label based on prompt type and scope
        const vendorLabel = vendor.charAt(0).toUpperCase() + vendor.slice(1);
        const modelLabel = model || "";
        let label: string;

        if (promptType === "systemPrompt") {
          label = model ? `${modelLabel} - System Prompt` : `${vendorLabel} - System Prompt`;
        } else if (promptType === "systemReminder") {
          label = model ? `${modelLabel} - System Reminder` : `${vendorLabel} - System Reminder`;
        } else {
          const toolName = promptType.replace("toolDescription.", "");
          label = model ? `${modelLabel} - ${toolName}` : `${vendorLabel} - ${toolName}`;
        }

        // Create the override setting
        await globalSettingsService.create(
          {
            key: settingKey,
            type: "text",
            label,
            description: `Override for ${promptType}. Leave empty to use parent level.`,
            category,
            sortOrder: 0,
          },
          currentUserId,
        );

        // Now set the value
        await globalSettingsService.setValue(settingKey, value, currentUserId);
      }
      // If value is null/empty and setting doesn't exist, nothing to do (no override)

      res.json({
        success: true,
        data: {
          key: settingKey,
          updated: value !== null && value !== undefined && value !== "",
          scope: model ? "model" : "agent",
          created: value !== null && value !== undefined && value !== "",
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Setting exists - update or reset value
    await globalSettingsService.setValue(settingKey, value, currentUserId);

    res.json({
      success: true,
      data: {
        key: settingKey,
        updated: true,
        scope: isDefault ? "default" : model ? "model" : "agent",
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/global-settings/preview-prompt - Preview effective prompt for agent/model
 * Returns the resolved prompt after applying override hierarchy (model → agent → default)
 * Useful for admin testing prompt overrides before publishing
 *
 * Body: { agent?: string, model?: string, type: "toolDescription" | "systemPrompt" | "systemReminder", toolName?: string }
 */
router.post(
  "/global-settings/preview-prompt",
  asyncHandler(async (req: Request, res: Response) => {
    const { agent, model, type, toolName } = req.body;

    if (!type) {
      throw createApiError.validationFailed(
        "type is required (toolDescription, systemPrompt, or systemReminder)",
      );
    }

    if (type === "toolDescription" && !toolName) {
      throw createApiError.validationFailed("toolName is required for toolDescription type");
    }

    const mcpTextService = getMcpTextService();
    const globalSettingsService = getGlobalSettingsService();

    const context = { agent: agent || null, model: model || null };
    let value: string | null = null;
    let resolvedFrom: "model" | "agent" | "default" = "default";
    let resolvedKey: string = "";

    // Helper to check if a key has a non-null value
    const hasValue = async (key: string): Promise<boolean> => {
      const setting = await globalSettingsService.get(key);
      return setting !== null && setting.value !== null;
    };

    if (type === "toolDescription") {
      value = await mcpTextService.getToolDescriptionWithOverride(toolName, context);

      // Determine which level the value came from
      if (model && agent) {
        const modelKey = MCP_TEXT_KEYS.modelToolDescription(agent, model, toolName);
        if (await hasValue(modelKey)) {
          resolvedFrom = "model";
          resolvedKey = modelKey;
        } else {
          const agentKey = MCP_TEXT_KEYS.agentToolDescription(agent, toolName);
          if (await hasValue(agentKey)) {
            resolvedFrom = "agent";
            resolvedKey = agentKey;
          } else {
            resolvedKey = MCP_TEXT_KEYS.toolDescription(toolName);
          }
        }
      } else if (agent) {
        const agentKey = MCP_TEXT_KEYS.agentToolDescription(agent, toolName);
        if (await hasValue(agentKey)) {
          resolvedFrom = "agent";
          resolvedKey = agentKey;
        } else {
          resolvedKey = MCP_TEXT_KEYS.toolDescription(toolName);
        }
      } else {
        resolvedKey = MCP_TEXT_KEYS.toolDescription(toolName);
      }
    } else if (type === "systemPrompt") {
      value = await mcpTextService.getSystemPromptWithOverride(context);

      // Determine which level the value came from
      if (model && agent) {
        const modelKey = MCP_TEXT_KEYS.modelSystemPrompt(agent, model);
        if (await hasValue(modelKey)) {
          resolvedFrom = "model";
          resolvedKey = modelKey;
        } else {
          const agentKey = MCP_TEXT_KEYS.agentSystemPrompt(agent);
          if (await hasValue(agentKey)) {
            resolvedFrom = "agent";
            resolvedKey = agentKey;
          } else {
            resolvedKey = MCP_TEXT_KEYS.systemPrompt;
          }
        }
      } else if (agent) {
        const agentKey = MCP_TEXT_KEYS.agentSystemPrompt(agent);
        if (await hasValue(agentKey)) {
          resolvedFrom = "agent";
          resolvedKey = agentKey;
        } else {
          resolvedKey = MCP_TEXT_KEYS.systemPrompt;
        }
      } else {
        resolvedKey = MCP_TEXT_KEYS.systemPrompt;
      }
    } else if (type === "systemReminder") {
      value = await mcpTextService.getSystemReminderWithOverride(context);

      // Determine which level the value came from (similar logic)
      if (model && agent) {
        const modelKey = MCP_TEXT_KEYS.modelSystemReminder(agent, model);
        if (await hasValue(modelKey)) {
          resolvedFrom = "model";
          resolvedKey = modelKey;
        } else {
          const agentKey = MCP_TEXT_KEYS.agentSystemReminder(agent);
          if (await hasValue(agentKey)) {
            resolvedFrom = "agent";
            resolvedKey = agentKey;
          } else {
            resolvedKey = MCP_TEXT_KEYS.systemReminder;
          }
        }
      } else if (agent) {
        const agentKey = MCP_TEXT_KEYS.agentSystemReminder(agent);
        if (await hasValue(agentKey)) {
          resolvedFrom = "agent";
          resolvedKey = agentKey;
        } else {
          resolvedKey = MCP_TEXT_KEYS.systemReminder;
        }
      } else {
        resolvedKey = MCP_TEXT_KEYS.systemReminder;
      }
    } else {
      throw createApiError.validationFailed(
        "Invalid type. Must be toolDescription, systemPrompt, or systemReminder",
      );
    }

    res.json({
      success: true,
      data: {
        value,
        resolvedFrom,
        resolvedKey,
        context: {
          agent: agent || null,
          model: model || null,
          type,
          ...(toolName && { toolName }),
        },
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/global-settings/export - Export all global settings values
 */
router.get(
  "/global-settings/export",
  asyncHandler(async (req: Request, res: Response) => {
    const globalSettingsService = getGlobalSettingsService();

    const settings = await globalSettingsService.getAll();

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_GLOBAL_SETTINGS_EXPORT,
      resource: "globalSetting",
      resourceId: "all",
      metadata: { count: settings.length },
    });

    const exportData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      settings: settings.map((s) => ({
        key: s.key,
        value: s.value,
        type: s.type,
        label: s.label,
        description: s.description,
        category: s.category,
      })),
    };

    res.json({
      success: true,
      data: exportData,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/executions - List all executions with user info
 * Query params: userId, status, search, limit, offset
 */
router.get(
  "/executions",
  asyncHandler(async (req: Request, res: Response) => {
    const { mapLegacyStatusArray, user, workflow, getDatabase } = await import("@mcp-moira/shared");

    const userId = req.query.userId as string | undefined;
    const statusParam = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 20), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    // Map status filter
    type LegacyStatus = "running" | "waiting" | "completed" | "failed" | "locked";
    const rawStatus = statusParam
      ? (statusParam
          .split(",")
          .filter((s) =>
            ["running", "waiting", "completed", "failed", "locked"].includes(s),
          ) as LegacyStatus[])
      : undefined;

    let adminDbStatuses: ReturnType<typeof mapLegacyStatusArray>["dbStatuses"] | undefined;
    let adminHasLockedFilter = false;
    let adminOriginalIncludedRunning = false;
    if (rawStatus) {
      const mapped = mapLegacyStatusArray(rawStatus);
      adminDbStatuses = mapped.dbStatuses;
      adminHasLockedFilter = mapped.hasLockedFilter;
      adminOriginalIncludedRunning = adminDbStatuses.includes("running");
      if (adminHasLockedFilter && !adminOriginalIncludedRunning) {
        adminDbStatuses = [...adminDbStatuses, "running"];
      }
    }

    // Server-side pagination via listExecutionsWithFilters
    const result = await repository.listExecutionsWithFilters({
      userId: userId || undefined,
      status: adminDbStatuses,
      search,
      sort: "createdAt",
      sortOrder: "desc",
      limit,
      offset,
    });

    // Get user info for enrichment
    const db = getDatabase();
    const users = await db.select({ id: user.id, email: user.email, name: user.name }).from(user);
    const userMap = new Map(users.map((u) => [u.id, { email: u.email, name: u.name }]));

    const workflows = await db.select({ id: workflow.id, name: workflow.name }).from(workflow);
    const workflowNameMap = new Map(workflows.map((w) => [w.id, w.name]));

    // Get active lock execution IDs for lock indicators
    const lockService = getLockService();
    const lockedExecutionIds = await lockService.getActiveExecutionIds();

    let enrichedExecutions = result.executions.map((exec) => {
      const userInfo = userMap.get(exec.userId);
      const isLocked = exec.status === "running" && lockedExecutionIds.has(exec.executionId);
      return {
        executionId: exec.executionId,
        workflowId: exec.workflowId,
        workflowName: workflowNameMap.get(exec.workflowId) || null,
        userId: exec.userId,
        userEmail: userInfo?.email || "Unknown",
        userName: userInfo?.name || null,
        status: isLocked ? ("locked" as const) : exec.status,
        currentNodeId: exec.currentNodeId,
        createdAt: exec.createdAt,
        updatedAt: exec.updatedAt,
        completedAt: exec.completedAt,
        error: exec.error,
        hasActiveLock: isLocked,
      };
    });

    // If filtering by "locked" only (not explicitly "running"), remove non-locked running execs
    let totalCount = result.total;
    if (adminHasLockedFilter && !adminOriginalIncludedRunning) {
      enrichedExecutions = enrichedExecutions.filter((e) => e.status !== "running");
      totalCount = enrichedExecutions.length;
    }

    res.json({
      success: true,
      data: {
        executions: enrichedExecutions,
        total: totalCount,
        limit,
        offset,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/executions/:id - Get execution details (admin can view any execution)
 */
router.get(
  "/executions/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId } = req.params;

    const execution = await repository.getExecution(executionId);

    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    // Get user info for enrichment
    const { user, workflow: workflowTable, getDatabase } = await import("@mcp-moira/shared");
    const db = getDatabase();
    const users = await db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
      })
      .from(user);

    const userMap = new Map(users.map((u) => [u.id, { email: u.email, name: u.name }]));
    const userInfo = userMap.get(execution.userId);

    // Issue #421: Resolve workflow name
    const allWorkflows = await db
      .select({ id: workflowTable.id, name: workflowTable.name })
      .from(workflowTable);
    const workflowNameMap = new Map(allWorkflows.map((w) => [w.id, w.name]));

    // Get active lock info
    const lockService = getLockService();
    const activeLock = await lockService.getActiveLock(executionId);

    res.json({
      success: true,
      data: {
        executionId: execution.executionId,
        workflowId: execution.workflowId,
        workflowName: workflowNameMap.get(execution.workflowId) || null,
        userId: execution.userId,
        userEmail: userInfo?.email || "Unknown",
        userName: userInfo?.name || null,
        status:
          execution.status === "running" && activeLock ? ("locked" as const) : execution.status,
        currentNodeId: execution.currentNodeId,
        waitingForInputNodeId: execution.waitingForInputNodeId,
        context: execution.globalContext,
        createdAt: execution.createdAt,
        updatedAt: execution.updatedAt,
        completedAt: execution.completedAt,
        error: execution.error,
        errors: execution.errors, // Issue #386: Full error log
        activeLock: activeLock
          ? {
              id: activeLock.id,
              nodeId: activeLock.nodeId,
              reason: activeLock.reason,
              status: activeLock.status,
              createdAt: activeLock.createdAt,
            }
          : null,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/audit-log - List audit log entries with filters and pagination
 */
router.get(
  "/audit-log",
  asyncHandler(async (req: Request, res: Response) => {
    const {
      userId,
      action,
      resource,
      resourceId,
      source,
      limit = "50",
      offset = "0",
      fromDate,
      toDate,
      sortBy,
      sortOrder,
    } = req.query;

    // Build filter
    const filter: {
      userId?: string;
      action?: string | string[];
      resource?: string;
      resourceId?: string;
      source?: string;
      fromDate?: number;
      toDate?: number;
      sortBy?: "createdAt" | "action" | "resource" | "source";
      sortOrder?: "asc" | "desc";
      limit: number;
      offset: number;
    } = {
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10),
    };

    if (userId && typeof userId === "string") {
      filter.userId = userId;
    }
    if (action && typeof action === "string") {
      // Support comma-separated multiple actions: ?action=create,update,delete
      const actions = action.split(",").filter(Boolean);
      filter.action = actions.length === 1 ? actions[0] : actions;
    }
    if (resource && typeof resource === "string") {
      filter.resource = resource;
    }
    if (resourceId && typeof resourceId === "string") {
      filter.resourceId = resourceId;
    }
    if (source && typeof source === "string") {
      filter.source = source;
    }
    if (fromDate && typeof fromDate === "string") {
      const parsed = parseInt(fromDate, 10);
      if (!isNaN(parsed)) filter.fromDate = parsed;
    }
    if (toDate && typeof toDate === "string") {
      const parsed = parseInt(toDate, 10);
      if (!isNaN(parsed)) filter.toDate = parsed;
    }
    if (
      sortBy &&
      typeof sortBy === "string" &&
      ["createdAt", "action", "resource", "source"].includes(sortBy)
    ) {
      filter.sortBy = sortBy as "createdAt" | "action" | "resource" | "source";
    }
    if (sortOrder && typeof sortOrder === "string" && ["asc", "desc"].includes(sortOrder)) {
      filter.sortOrder = sortOrder as "asc" | "desc";
    }

    // Query audit log through repository with total count
    const { entries, total } = await repository.getAuditLogsWithTotal(filter);

    // Get user info for enrichment
    const { user, getDatabase } = await import("@mcp-moira/shared");
    const db = getDatabase();
    const users = await db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
      })
      .from(user);

    const userMap = new Map(users.map((u) => [u.id, { email: u.email, name: u.name }]));

    // Enrich entries with user info
    const enrichedEntries = entries.map((entry) => {
      const userInfo = entry.userId ? userMap.get(entry.userId) : null;
      return {
        ...entry,
        userEmail: userInfo?.email || (entry.userId ? "Unknown" : null),
        userName: userInfo?.name || null,
      };
    });

    res.json({
      success: true,
      data: {
        entries: enrichedEntries,
        total,
        limit: filter.limit,
        offset: filter.offset,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/audit/actions - Get all available audit action types
 * Returns the complete list of AuditAction enum values for UI filtering
 */
router.get(
  "/audit/actions",
  asyncHandler(async (req: Request, res: Response) => {
    // Get all enum values from AuditAction
    const actions = Object.values(AuditAction);

    // Group actions by category for better UI organization
    const grouped: Record<string, string[]> = {};
    for (const action of actions) {
      const category = action.split(":")[0];
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(action);
    }

    res.json({
      success: true,
      data: {
        actions,
        grouped,
        totalCount: actions.length,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/sessions/all - Logout all users (delete all sessions except current)
 */
router.delete(
  "/sessions/all",
  asyncHandler(async (req: Request, res: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentSessionToken = (req as any).session?.token;

    const { session, getDatabase } = await import("@mcp-moira/shared");
    const { ne } = await import("drizzle-orm");
    const db = getDatabase();

    // Delete all sessions except the current admin's session
    let deletedSessions;
    if (currentSessionToken) {
      deletedSessions = await db
        .delete(session)
        .where(ne(session.token, currentSessionToken))
        .returning();
    } else {
      // If no token found, delete all sessions
      deletedSessions = await db.delete(session).returning();
    }

    // Audit logging
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_LOGOUT_ALL_USERS,
      resource: "session",
      resourceId: "all",
      metadata: {
        deletedCount: deletedSessions.length,
        preservedCurrentSession: !!currentSessionToken,
      },
    });

    res.json({
      success: true,
      data: {
        deletedSessions: deletedSessions.length,
        message: `Logged out ${deletedSessions.length} sessions`,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

// ===== Artifact Admin Endpoints =====

/**
 * GET /api/admin/artifacts - List all artifacts with filters
 * Query params: userId, limit, offset, includeExpired, includeDeleted
 */
router.get(
  "/artifacts",
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, limit = "50", offset = "0", includeExpired, includeDeleted } = req.query;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    const artifactService = getArtifactService();

    const result = await artifactService.adminList(currentUserId, {
      userId: userId as string | undefined,
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10),
      includeExpired: includeExpired === "true",
      includeDeleted: includeDeleted === "true",
    });

    // Enrich with user info
    const { user, getDatabase } = await import("@mcp-moira/shared");
    const db = getDatabase();
    const users = await db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        handle: user.handle,
      })
      .from(user);

    const userMap = new Map(
      users.map((u) => [u.id, { email: u.email, name: u.name, handle: u.handle }]),
    );

    const enrichedArtifacts = result.artifacts.map((a) => {
      const userInfo = userMap.get(a.userId);
      return {
        ...a,
        url: getArtifactUrl(a.uuid),
        userEmail: userInfo?.email || "Unknown",
        userName: userInfo?.name || null,
        userHandle: userInfo?.handle || null,
      };
    });

    res.json({
      success: true,
      data: {
        artifacts: enrichedArtifacts,
        total: result.total,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/artifacts/stats - Get system-wide artifact statistics
 */
router.get(
  "/artifacts/stats",
  asyncHandler(async (req: Request, res: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    const artifactService = getArtifactService();
    const stats = await artifactService.adminGetSystemStats(currentUserId);

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/artifacts/:uuid - Admin delete any artifact
 */
router.delete(
  "/artifacts/:uuid",
  asyncHandler(async (req: Request, res: Response) => {
    const { uuid } = req.params;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    const artifactService = getArtifactService();

    await artifactService.adminDelete(currentUserId, uuid);

    res.json({
      success: true,
      data: { uuid, deleted: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/artifacts/reported - List reported artifacts for abuse review
 * Query: limit?, offset?, includeTakenDown? (default true)
 */
router.get(
  "/artifacts/reported",
  asyncHandler(async (req: Request, res: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    const { limit, offset, includeTakenDown } = req.query;

    const artifactService = getArtifactService();
    const result = await artifactService.adminListReported(currentUserId, {
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
      includeTakenDown: includeTakenDown === undefined ? true : includeTakenDown === "true",
    });

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/artifacts/:uuid/takedown - Take down an artifact (abuse)
 * Body: { reason: string }
 */
router.post(
  "/artifacts/:uuid/takedown",
  asyncHandler(async (req: Request, res: Response) => {
    const { uuid } = req.params;
    const { reason } = req.body ?? {};

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      throw createApiError.validationFailed("Missing required field: reason");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    const artifactService = getArtifactService();
    await artifactService.adminTakedown(currentUserId, uuid, reason.trim());

    res.json({
      success: true,
      data: { uuid, takenDown: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/users/:id/artifacts/takedown - Take down ALL of a user's artifacts
 * Body: { reason: string }
 */
router.post(
  "/users/:id/artifacts/takedown",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { reason } = req.body ?? {};

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      throw createApiError.validationFailed("Missing required field: reason");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    const artifactService = getArtifactService();
    const count = await artifactService.adminTakedownAllForUser(currentUserId, id, reason.trim());

    res.json({
      success: true,
      data: { userId: id, takenDownCount: count },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PUT /api/admin/users/:id/artifact-quota - Set per-user artifact quota overrides
 * Body: { quotaMb: number | null, maxFiles: number | null }
 * Pass null to reset to global default
 */
router.put(
  "/users/:id/artifact-quota",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { quotaMb, maxFiles } = req.body;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    // Validate input
    if (quotaMb !== undefined && quotaMb !== null && (typeof quotaMb !== "number" || quotaMb < 0)) {
      throw createApiError.validationFailed("quotaMb must be a positive number or null");
    }
    if (
      maxFiles !== undefined &&
      maxFiles !== null &&
      (typeof maxFiles !== "number" || maxFiles < 0)
    ) {
      throw createApiError.validationFailed("maxFiles must be a positive number or null");
    }

    const { user, getDatabase, UserRepository } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Check user exists
    const [existing] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!existing) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Get previous values for audit
    const userRepo = new UserRepository(db);
    const previousQuota = await userRepo.getArtifactQuota(id);

    // Update quota
    const updated = await userRepo.updateArtifactQuota(
      id,
      quotaMb !== undefined ? quotaMb : previousQuota.artifactQuotaMb,
      maxFiles !== undefined ? maxFiles : previousQuota.artifactMaxFiles,
    );

    if (!updated) {
      throw createApiError.internal("Failed to update quota");
    }

    // Audit logging
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_ARTIFACT_QUOTA_UPDATE,
      resource: "user",
      resourceId: id,
      metadata: {
        previousQuotaMb: previousQuota.artifactQuotaMb,
        previousMaxFiles: previousQuota.artifactMaxFiles,
        newQuotaMb: quotaMb !== undefined ? quotaMb : previousQuota.artifactQuotaMb,
        newMaxFiles: maxFiles !== undefined ? maxFiles : previousQuota.artifactMaxFiles,
      },
    });

    res.json({
      success: true,
      data: {
        userId: id,
        quotaMb: quotaMb !== undefined ? quotaMb : previousQuota.artifactQuotaMb,
        maxFiles: maxFiles !== undefined ? maxFiles : previousQuota.artifactMaxFiles,
        updated: true,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/users/:id/artifact-quota - Get user's artifact quota
 */
router.get(
  "/users/:id/artifact-quota",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;

    const {
      user,
      getDatabase,
      UserRepository,
      getArtifactService: getArtSvc,
    } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Check user exists
    const [existing] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!existing) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Get per-user overrides
    const userRepo = new UserRepository(db);
    const quota = await userRepo.getArtifactQuota(id);

    // Get current usage
    const artifactService = getArtSvc();
    const stats = await artifactService.getStats(id);

    res.json({
      success: true,
      data: {
        userId: id,
        overrides: {
          quotaMb: quota.artifactQuotaMb,
          maxFiles: quota.artifactMaxFiles,
        },
        effective: {
          storageLimit: stats.storageLimit,
          countLimit: stats.countLimit,
        },
        usage: {
          totalSize: stats.totalSize,
          totalArtifacts: stats.totalArtifacts,
          storageUsedPercent: stats.storageUsedPercent,
          countUsedPercent: stats.countUsedPercent,
        },
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/executions/:id/locks - List all locks for an execution
 */
router.get(
  "/executions/:id/locks",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId } = req.params;

    const execution = await repository.getExecution(executionId);
    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    const lockService = getLockService();
    const locks = await lockService.listLocks(executionId);

    res.json({
      success: true,
      data: {
        locks: locks.map((lock) => ({
          id: lock.id,
          nodeId: lock.nodeId,
          reason: lock.reason,
          lockedBy: lock.lockedBy,
          status: lock.status,
          createdAt: lock.createdAt,
          unlockedAt: lock.unlockedAt,
        })),
        total: locks.length,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/admin/executions/:id/locks/:lockId/unlock - Admin override unlock
 */
router.post(
  "/executions/:id/locks/:lockId/unlock",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId, lockId } = req.params;

    const execution = await repository.getExecution(executionId);
    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    const lockService = getLockService();
    const lock = await lockService.getLock(lockId);

    if (!lock) {
      throw createApiError.notFound(`Lock '${lockId}' not found`, { lockId });
    }

    if (lock.executionId !== executionId) {
      throw createApiError.badRequest("Lock does not belong to this execution");
    }

    if (lock.status !== "active") {
      throw createApiError.badRequest(`Lock is already '${lock.status}', cannot unlock`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adminUserId = (req as any).user?.userId;
    await lockService.adminUnlock(lockId, adminUserId);

    res.json({
      success: true,
      data: { lockId, status: "unlocked", adminOverride: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as adminRoutes };
