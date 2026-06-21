/**
 * Workflow Repository - Domain repository for workflows
 * Drizzle ORM queries for workflow operations
 *
 * Key concepts:
 * - id: Internal UUID, auto-generated, used for all internal operations
 * - slug: User-facing identifier, unique per user, used for URLs and references
 * - Global reference: handle/slug (resolved at service layer)
 */

import { eq, and, or, isNull, like, desc, asc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { workflow, user, workflowAccess } from "../schema.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { createLogger } from "../../logging/logger.js";
import type * as schema from "../schema.js";
import { v4 as uuidv4 } from "uuid";
import {
  generateSlugFromName,
  generateDefaultSlug,
  validateSlug,
  normalizeSlug,
} from "../../validation/slug-handle.js";
import { executeListQuery, type ListQueryConfig } from "../list-query-builder.js";

const DELETED_WORKFLOW_LIST_CONFIG: ListQueryConfig<"name" | "deletedAt"> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: workflow as any,
  sortableColumns: {
    name: workflow.name,
    deletedAt: workflow.deletedAt,
  },
  defaultSort: { field: "deletedAt", order: "desc" },
  defaultLimit: 20,
  maxLimit: 100,
};

const ADMIN_WORKFLOW_LIST_CONFIG: ListQueryConfig<"name" | "createdAt" | "updatedAt"> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: workflow as any,
  sortableColumns: {
    name: workflow.name,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  },
  defaultSort: { field: "updatedAt", order: "desc" },
  defaultLimit: 20,
  maxLimit: 100,
};

/**
 * Filter parameters for workflow list queries
 */
export interface WorkflowFilter {
  userId: string;
  search?: string; // Search in name, description, and slug
  visibility?: "public" | "private" | "all";
  sort?: "createdAt" | "name";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * Admin filter for listing ALL workflows (no userId ownership constraint)
 */
export interface AdminWorkflowFilter {
  search?: string;
  userId?: string; // Filter by specific owner (optional)
  visibility?: "public" | "private" | "all";
  isValid?: boolean | null; // true = valid, false = invalid, null = unknown
  fromDate?: number; // Filter workflows updated after this timestamp (ms)
  toDate?: number; // Filter workflows updated before this timestamp (ms)
  sort?: "createdAt" | "updatedAt" | "name";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * Admin workflow info — lightweight version for admin list
 */
export interface AdminWorkflowInfo {
  id: string;
  slug: string;
  userId: string;
  ownerHandle: string;
  name: string;
  description: string | null;
  version: string;
  visibility: "public" | "private";
  nodeCount: number;
  validation: ValidationCache;
  createdAt: number;
  updatedAt: number;
}

/**
 * Result of paginated admin workflow list
 */
export interface AdminWorkflowListResult {
  workflows: AdminWorkflowInfo[];
  total: number;
}

/**
 * Result of paginated workflow list
 */
export interface WorkflowListResult {
  workflows: WorkflowInfo[];
  total: number;
}

/**
 * Validation status for cached validation
 */
export type ValidationStatus = "valid" | "invalid" | "unknown";

/**
 * Cached validation info
 */
export interface ValidationCache {
  status: ValidationStatus;
  errors: string[];
  validatedAt: number | null;
}

/**
 * Workflow info with slug and owner handle
 */
export interface WorkflowInfo {
  id: string;
  slug: string;
  userId: string;
  ownerHandle: string;
  visibility: "public" | "private";
  accessType: "owner" | "shared" | "public";
  metadata: WorkflowGraph["metadata"];
  storagePath: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  workflow: WorkflowGraph;
  // Cached validation info (Issue #463)
  validation: ValidationCache;
}

/**
 * Workflow ownership and metadata
 */
export interface WorkflowOwnership {
  exists: boolean;
  id: string | null;
  slug: string | null;
  name: string | null;
  ownerId: string | null;
  ownerHandle: string | null;
  visibility: "public" | "private" | null;
}

/**
 * Options for saving a workflow
 */
export interface SaveWorkflowOptions {
  graph: WorkflowGraph;
  userId: string;
  slug?: string; // Optional - will be generated if not provided
  visibility?: "public" | "private";
  /**
   * Admin bypass flag - allows updating workflow owned by another user
   * IMPORTANT: Caller MUST verify admin role before setting this flag
   * This flag is NOT validated here - it's trusted
   */
  adminBypass?: boolean;
}

/**
 * Function to check if a user has shared access to a workflow
 * Used for dependency injection to avoid circular imports
 */
export type SharedAccessChecker = (workflowId: string, userId: string) => Promise<boolean>;

/**
 * Parse validation cache from DB columns into ValidationCache object
 */
function parseValidationCache(
  isValid: boolean | null | undefined,
  validationErrors: string | null | undefined,
  validatedAt: Date | number | null | undefined,
): ValidationCache {
  // Determine status: null = unknown, true = valid, false = invalid
  let status: ValidationStatus;
  if (isValid === null || isValid === undefined) {
    status = "unknown";
  } else {
    status = isValid ? "valid" : "invalid";
  }

  // Parse errors JSON array
  let errors: string[] = [];
  if (validationErrors) {
    try {
      const parsed = JSON.parse(validationErrors);
      if (Array.isArray(parsed)) {
        errors = parsed;
      }
    } catch {
      // Invalid JSON - treat as no errors
    }
  }

  // Parse timestamp
  let parsedValidatedAt: number | null = null;
  if (validatedAt) {
    if (typeof validatedAt === "number") {
      parsedValidatedAt = validatedAt;
    } else if (validatedAt instanceof Date) {
      parsedValidatedAt = validatedAt.getTime();
    }
  }

  return { status, errors, validatedAt: parsedValidatedAt };
}

export class WorkflowRepository {
  private logger = createLogger({ component: "WorkflowRepository" });
  private sharedAccessChecker: SharedAccessChecker | null = null;

  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /**
   * Set the shared access checker function
   * Call this after construction to enable shared access checking
   */
  setSharedAccessChecker(checker: SharedAccessChecker): void {
    this.sharedAccessChecker = checker;
  }

  // ===== Slug Resolution =====

  /**
   * Resolve a slug to workflow ID for a specific user
   * @param slug - Workflow slug
   * @param userId - Owner user ID
   * @returns Workflow ID or null if not found
   */
  async resolveSlug(slug: string, userId: string): Promise<string | null> {
    const normalizedSlug = normalizeSlug(slug);

    const [row] = await this.db
      .select({ id: workflow.id, deleted: workflow.deleted })
      .from(workflow)
      .where(and(eq(workflow.slug, normalizedSlug), eq(workflow.userId, userId)))
      .limit(1);

    if (!row || row.deleted) {
      return null;
    }

    return row.id;
  }

  /**
   * Resolve a slug to workflow ID, allowing public access
   * @param slug - Workflow slug
   * @param ownerUserId - Owner user ID (not current user)
   * @param currentUserId - Current user ID (for access check)
   * @returns Workflow ID or null if not found or no access
   */
  async resolveSlugWithAccess(
    slug: string,
    ownerUserId: string,
    currentUserId: string,
  ): Promise<string | null> {
    const normalizedSlug = normalizeSlug(slug);

    const [row] = await this.db
      .select({
        id: workflow.id,
        userId: workflow.userId,
        visibility: workflow.visibility,
        deleted: workflow.deleted,
      })
      .from(workflow)
      .where(and(eq(workflow.slug, normalizedSlug), eq(workflow.userId, ownerUserId)))
      .limit(1);

    if (!row || row.deleted) {
      return null;
    }

    // Check access: owner can always access, others only if public
    if (row.userId === currentUserId || row.visibility === "public") {
      return row.id;
    }

    // Check shared access (if checker is available)
    if (this.sharedAccessChecker) {
      const hasSharedAccess = await this.sharedAccessChecker(row.id, currentUserId);
      if (hasSharedAccess) {
        return row.id;
      }
    }

    return null;
  }

  /**
   * Resolve a slug to workflow ID across all users (public workflows only)
   * Used for admin override to find existing public workflow by slug
   * @returns Object with workflow id and owner userId, or null if not found
   */
  async resolvePublicSlug(
    slug: string,
  ): Promise<{ id: string; userId: string; ownerHandle: string | null } | null> {
    const normalizedSlug = normalizeSlug(slug);

    const [row] = await this.db
      .select({
        id: workflow.id,
        userId: workflow.userId,
        ownerHandle: user.handle,
        deleted: workflow.deleted,
      })
      .from(workflow)
      .leftJoin(user, eq(workflow.userId, user.id))
      .where(
        and(
          eq(workflow.slug, normalizedSlug),
          eq(workflow.visibility, "public"),
          or(eq(workflow.deleted, false), isNull(workflow.deleted)),
        ),
      )
      .orderBy(asc(workflow.createdAt))
      .limit(1);

    if (!row) {
      return null;
    }

    return { id: row.id, userId: row.userId, ownerHandle: row.ownerHandle };
  }

  /**
   * Check if a slug exists for a user
   */
  async slugExists(slug: string, userId: string, excludeWorkflowId?: string): Promise<boolean> {
    const normalizedSlug = normalizeSlug(slug);

    const conditions = [eq(workflow.slug, normalizedSlug), eq(workflow.userId, userId)];

    if (excludeWorkflowId) {
      conditions.push(sql`${workflow.id} != ${excludeWorkflowId}`);
    }

    const [row] = await this.db
      .select({ id: workflow.id })
      .from(workflow)
      .where(and(...conditions))
      .limit(1);

    return !!row;
  }

  /**
   * Generate a unique slug for a user, with collision resolution
   */
  async generateUniqueSlug(userId: string, baseName?: string): Promise<string> {
    const baseSlug = baseName ? generateSlugFromName(baseName) : generateDefaultSlug();
    let slug = baseSlug;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      const exists = await this.slugExists(slug, userId);
      if (!exists) {
        return slug;
      }

      // Add random suffix for collision resolution
      const suffix = Math.random().toString(36).substring(2, 6);
      slug = `${baseSlug}-${suffix}`;
      attempts++;
    }

    // Fallback: use UUID-based slug
    return `workflow-${uuidv4().substring(0, 8)}`;
  }

  // ===== List Operations =====

  async list(userId: string, includeDeleted: boolean = false): Promise<WorkflowInfo[]> {
    this.logger.info("list() called", { userId, includeDeleted });

    const conditions = [or(eq(workflow.userId, userId), eq(workflow.visibility, "public"))];

    // Exclude deleted workflows by default
    if (!includeDeleted) {
      conditions.push(or(eq(workflow.deleted, false), isNull(workflow.deleted)));
    }

    const rows = await this.db
      .select({
        id: workflow.id,
        slug: workflow.slug,
        userId: workflow.userId,
        ownerHandle: user.handle,
        visibility: workflow.visibility,
        graph: workflow.graph,
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt,
        isValid: workflow.isValid,
        validationErrors: workflow.validationErrors,
        validatedAt: workflow.validatedAt,
      })
      .from(workflow)
      .leftJoin(user, eq(workflow.userId, user.id))
      .where(and(...conditions))
      .orderBy(workflow.updatedAt);

    this.logger.info("list() DB query returned", {
      rowCount: rows.length,
      ids: rows.map((r) => r.id),
    });

    return rows.map((row) => {
      const graph = JSON.parse(row.graph) as WorkflowGraph;
      // Determine access type: owner if user owns it, public otherwise
      const accessType: "owner" | "shared" | "public" = row.userId === userId ? "owner" : "public";
      return {
        id: row.id,
        slug: row.slug,
        userId: row.userId,
        ownerHandle: row.ownerHandle || "unknown",
        visibility: row.visibility as "public" | "private",
        accessType,
        metadata: graph.metadata,
        storagePath: `database:workflow:${row.id}`,
        size: row.graph.length,
        createdAt: row.createdAt ? (row.createdAt as Date).getTime() : Date.now(),
        updatedAt: row.updatedAt ? (row.updatedAt as Date).getTime() : Date.now(),
        workflow: graph,
        validation: parseValidationCache(row.isValid, row.validationErrors, row.validatedAt),
      };
    });
  }

  /**
   * List workflows with filtering, sorting, and pagination
   */
  async listWithFilters(filter: WorkflowFilter): Promise<WorkflowListResult> {
    const {
      userId,
      search,
      visibility,
      sort = "createdAt",
      sortOrder = "desc",
      limit = 20,
      offset = 0,
    } = filter;

    this.logger.info("listWithFilters() called", {
      userId,
      search,
      visibility,
      sort,
      sortOrder,
      limit,
      offset,
    });

    // Build base conditions - user's own workflows OR public workflows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conditions: any[] = [];

    // Subquery for shared access - workflows where user has been granted access
    const sharedAccessSubquery = this.db
      .select({ workflowId: workflowAccess.workflowId })
      .from(workflowAccess)
      .where(eq(workflowAccess.userId, userId));

    // Visibility filter
    if (visibility === "public") {
      conditions.push(eq(workflow.visibility, "public"));
    } else if (visibility === "private") {
      conditions.push(and(eq(workflow.userId, userId), eq(workflow.visibility, "private")));
    } else {
      // 'all' or undefined - user's own + public + shared with user
      conditions.push(
        or(
          eq(workflow.userId, userId),
          eq(workflow.visibility, "public"),
          sql`${workflow.id} IN (${sharedAccessSubquery})`,
        ),
      );
    }

    // Exclude deleted workflows
    conditions.push(or(eq(workflow.deleted, false), isNull(workflow.deleted)));

    // Search filter - search in slug, name AND description columns
    if (search) {
      conditions.push(
        or(
          like(workflow.slug, `%${search}%`),
          like(workflow.name, `%${search}%`),
          like(workflow.description, `%${search}%`),
        ),
      );
    }

    const whereClause = and(...conditions)!; // Non-null assertion: conditions always has at least 2 elements

    // Get total count (correct count for pagination)
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(workflow)
      .where(whereClause);
    const total = countResult[0]?.count ?? 0;

    // Get paginated results with sorting
    const sortColumn = sort === "name" ? workflow.name : workflow.updatedAt;
    const sortFn = sortOrder === "asc" ? asc : desc;

    const rows = await this.db
      .select({
        id: workflow.id,
        slug: workflow.slug,
        userId: workflow.userId,
        ownerHandle: user.handle,
        visibility: workflow.visibility,
        graph: workflow.graph,
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt,
        isValid: workflow.isValid,
        validationErrors: workflow.validationErrors,
        validatedAt: workflow.validatedAt,
      })
      .from(workflow)
      .leftJoin(user, eq(workflow.userId, user.id))
      .where(whereClause)
      .orderBy(sortFn(sortColumn))
      .limit(limit)
      .offset(offset);

    this.logger.info("listWithFilters() DB query returned", { rowCount: rows.length, total });

    const workflows = rows.map((row) => {
      const graph = JSON.parse(row.graph) as WorkflowGraph;
      // Determine access type: owner > shared > public
      let accessType: "owner" | "shared" | "public";
      if (row.userId === userId) {
        accessType = "owner";
      } else if (row.visibility === "public") {
        accessType = "public";
      } else {
        // Private workflow that's not owned by user must be shared
        accessType = "shared";
      }
      return {
        id: row.id,
        slug: row.slug,
        userId: row.userId,
        ownerHandle: row.ownerHandle || "unknown",
        visibility: row.visibility as "public" | "private",
        accessType,
        metadata: graph.metadata,
        storagePath: `database:workflow:${row.id}`,
        size: row.graph.length,
        createdAt: row.createdAt ? (row.createdAt as Date).getTime() : Date.now(),
        updatedAt: row.updatedAt ? (row.updatedAt as Date).getTime() : Date.now(),
        workflow: graph,
        validation: parseValidationCache(row.isValid, row.validationErrors, row.validatedAt),
      };
    });

    return {
      workflows,
      total,
    };
  }

  // ===== Get Operations =====

  /**
   * Get workflow by ID
   * Checks access: owner OR public OR shared (via sharedAccessChecker)
   */
  async get(
    workflowId: string | undefined,
    userId: string,
    includeDeleted: boolean = false,
  ): Promise<WorkflowGraph | null> {
    // A graph without an id is a new workflow — nothing to fetch.
    if (!workflowId) {
      return null;
    }

    // First get the workflow without access filter to determine access type
    const baseConditions = [eq(workflow.id, workflowId)];

    // Exclude deleted workflows by default
    if (!includeDeleted) {
      baseConditions.push(or(eq(workflow.deleted, false), isNull(workflow.deleted))!);
    }

    const [row] = await this.db
      .select({
        id: workflow.id,
        userId: workflow.userId,
        visibility: workflow.visibility,
        graph: workflow.graph,
      })
      .from(workflow)
      .where(and(...baseConditions))
      .limit(1);

    if (!row) {
      return null;
    }

    // Check access: owner OR public OR shared
    if (row.userId === userId || row.visibility === "public") {
      return JSON.parse(row.graph) as WorkflowGraph;
    }

    // Check shared access (if checker is available)
    if (this.sharedAccessChecker) {
      const hasSharedAccess = await this.sharedAccessChecker(row.id, userId);
      if (hasSharedAccess) {
        return JSON.parse(row.graph) as WorkflowGraph;
      }
    }

    // User has no access to this workflow
    return null;
  }

  /**
   * Get workflow by slug (for current user's own workflow)
   */
  async getBySlug(
    slug: string,
    userId: string,
    includeDeleted: boolean = false,
  ): Promise<WorkflowGraph | null> {
    const normalizedSlug = normalizeSlug(slug);
    const workflowId = await this.resolveSlug(normalizedSlug, userId);

    if (!workflowId) {
      return null;
    }

    return this.get(workflowId, userId, includeDeleted);
  }

  /**
   * Get full workflow info including slug and owner handle
   * Determines access type: owner (user owns it), shared (via invite), public (visible to all)
   */
  async getFullInfo(
    workflowId: string | undefined,
    userId: string,
    includeDeleted: boolean = false,
  ): Promise<WorkflowInfo | null> {
    // A graph without an id is a new workflow — nothing to fetch.
    if (!workflowId) {
      return null;
    }

    // First get the workflow without access filter to determine access type
    const baseConditions = [eq(workflow.id, workflowId)];

    if (!includeDeleted) {
      baseConditions.push(or(eq(workflow.deleted, false), isNull(workflow.deleted))!);
    }

    const [row] = await this.db
      .select({
        id: workflow.id,
        slug: workflow.slug,
        userId: workflow.userId,
        ownerHandle: user.handle,
        visibility: workflow.visibility,
        graph: workflow.graph,
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt,
        isValid: workflow.isValid,
        validationErrors: workflow.validationErrors,
        validatedAt: workflow.validatedAt,
      })
      .from(workflow)
      .leftJoin(user, eq(workflow.userId, user.id))
      .where(and(...baseConditions)!) // Non-null assertion: baseConditions always has at least 1 element
      .limit(1);

    if (!row) {
      return null;
    }

    // Determine access type
    let accessType: "owner" | "shared" | "public";
    if (row.userId === userId) {
      accessType = "owner";
    } else if (row.visibility === "public") {
      accessType = "public";
    } else if (this.sharedAccessChecker) {
      // Check if user has shared access
      const hasSharedAccess = await this.sharedAccessChecker(row.id, userId);
      if (hasSharedAccess) {
        accessType = "shared";
      } else {
        // User has no access to this private workflow
        return null;
      }
    } else {
      // No shared access checker and not owner/public - deny access
      return null;
    }

    const graph = JSON.parse(row.graph) as WorkflowGraph;
    return {
      id: row.id,
      slug: row.slug,
      userId: row.userId,
      ownerHandle: row.ownerHandle || "unknown",
      visibility: row.visibility as "public" | "private",
      accessType,
      metadata: graph.metadata,
      storagePath: `database:workflow:${row.id}`,
      size: row.graph.length,
      createdAt: row.createdAt ? (row.createdAt as Date).getTime() : Date.now(),
      updatedAt: row.updatedAt ? (row.updatedAt as Date).getTime() : Date.now(),
      workflow: graph,
      validation: parseValidationCache(row.isValid, row.validationErrors, row.validatedAt),
    };
  }

  /**
   * Check if workflow exists and get ownership info
   * Used for security checks before modifications
   */
  async getOwnership(workflowId: string | undefined): Promise<WorkflowOwnership> {
    if (!workflowId) {
      // A graph without an id is a new workflow — it cannot exist yet.
      return {
        exists: false,
        id: null,
        slug: null,
        name: null,
        ownerId: null,
        ownerHandle: null,
        visibility: null,
      };
    }

    const [row] = await this.db
      .select({
        id: workflow.id,
        slug: workflow.slug,
        graph: workflow.graph,
        userId: workflow.userId,
        ownerHandle: user.handle,
        visibility: workflow.visibility,
        deleted: workflow.deleted,
      })
      .from(workflow)
      .leftJoin(user, eq(workflow.userId, user.id))
      .where(eq(workflow.id, workflowId))
      .limit(1);

    if (!row || row.deleted) {
      return {
        exists: false,
        id: null,
        slug: null,
        name: null,
        ownerId: null,
        ownerHandle: null,
        visibility: null,
      };
    }

    // Extract workflow name from graph JSON
    let workflowName: string | null = null;
    try {
      const graphData = JSON.parse(row.graph) as WorkflowGraph;
      workflowName = graphData.metadata?.name || null;
    } catch {
      // Ignore JSON parse errors - name will be null
    }

    return {
      exists: true,
      id: row.id,
      slug: row.slug,
      name: workflowName,
      ownerId: row.userId,
      ownerHandle: row.ownerHandle,
      visibility: row.visibility as "public" | "private",
    };
  }

  /**
   * Check if user can modify workflow (is owner)
   */
  async canModify(workflowId: string, userId: string): Promise<boolean> {
    const ownership = await this.getOwnership(workflowId);
    return ownership.exists && ownership.ownerId === userId;
  }

  // ===== Save Operations =====

  /**
   * Save workflow with automatic UUID and slug generation
   */
  async save(options: SaveWorkflowOptions): Promise<{ id: string; slug: string }> {
    const { graph, userId, slug: providedSlug, visibility = "private", adminBypass } = options;
    const now = new Date();

    // Size validation: max 5MB for workflow JSON
    const graphJson = JSON.stringify(graph);
    const sizeBytes = Buffer.byteLength(graphJson, "utf8");
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (sizeBytes > maxSize) {
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
      const maxMB = (maxSize / 1024 / 1024).toFixed(0);
      throw new Error(`Workflow size ${sizeMB}MB exceeds maximum ${maxMB}MB limit`);
    }

    // Check if this is an update (graph.id exists and matches existing workflow)
    const ownership = await this.getOwnership(graph.id);

    if (ownership.exists) {
      // ownership.exists ⟹ the lookup matched a row, so its id is present.
      const existingId = ownership.id!;

      // Update existing workflow - verify user is owner OR admin bypass is enabled
      if (ownership.ownerId !== userId && !adminBypass) {
        throw new Error(
          `Access denied: you cannot modify workflow '${existingId}' owned by another user`,
        );
      }

      // Update - only owner can update
      await this.db
        .update(workflow)
        .set({
          name: graph.metadata.name,
          description: graph.metadata.description || null,
          version: graph.metadata.version,
          graph: graphJson,
          visibility,
          deleted: false,
          deletedAt: null,
          deletedBy: null,
          updatedAt: now,
        })
        .where(eq(workflow.id, existingId));

      return { id: existingId, slug: ownership.slug! };
    } else {
      // Insert new workflow - generate UUID and slug
      const workflowId = uuidv4();

      // Generate or validate slug
      let finalSlug: string;
      if (providedSlug) {
        const validation = validateSlug(providedSlug);
        if (!validation.valid) {
          throw new Error(`Invalid slug: ${validation.error}`);
        }
        finalSlug = normalizeSlug(providedSlug);

        // Check for collision
        const exists = await this.slugExists(finalSlug, userId);
        if (exists) {
          throw new Error(`Slug '${finalSlug}' already exists for this user`);
        }
      } else {
        // Auto-generate from workflow name
        finalSlug = await this.generateUniqueSlug(userId, graph.metadata.name);
      }

      // Update graph.id to use the new UUID
      const graphWithId = { ...graph, id: workflowId };

      await this.db.insert(workflow).values({
        id: workflowId,
        userId,
        slug: finalSlug,
        name: graph.metadata.name,
        description: graph.metadata.description || null,
        version: graph.metadata.version,
        graph: JSON.stringify(graphWithId),
        visibility,
        createdAt: now,
        updatedAt: now,
      });

      return { id: workflowId, slug: finalSlug };
    }
  }

  /**
   * Update workflow slug
   * @returns true if update succeeded, false if not found
   * @throws Error if slug is invalid or already exists
   */
  async updateSlug(workflowId: string, userId: string, newSlug: string): Promise<boolean> {
    const validation = validateSlug(newSlug);
    if (!validation.valid) {
      throw new Error(`Invalid slug: ${validation.error}`);
    }

    const normalizedSlug = normalizeSlug(newSlug);

    // Check for collision (excluding current workflow)
    const exists = await this.slugExists(normalizedSlug, userId, workflowId);
    if (exists) {
      throw new Error(`Slug '${normalizedSlug}' already exists for this user`);
    }

    const now = new Date();

    const result = await this.db
      .update(workflow)
      .set({
        slug: normalizedSlug,
        updatedAt: now,
      })
      .where(
        and(
          eq(workflow.id, workflowId),
          eq(workflow.userId, userId),
          or(eq(workflow.deleted, false), isNull(workflow.deleted)),
        ),
      );

    return result.changes > 0;
  }

  // ===== Delete Operations =====

  async delete(workflowId: string, userId: string): Promise<void> {
    // Hard delete - only owner can delete
    await this.db
      .delete(workflow)
      .where(and(eq(workflow.id, workflowId), eq(workflow.userId, userId)));
  }

  async softDelete(workflowId: string, userId: string): Promise<boolean> {
    // Soft delete - mark as deleted
    const now = new Date();

    const result = await this.db
      .update(workflow)
      .set({
        deleted: true,
        deletedAt: now,
        deletedBy: userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(workflow.id, workflowId),
          eq(workflow.userId, userId),
          or(eq(workflow.deleted, false), isNull(workflow.deleted)),
        ),
      );

    return result.changes > 0;
  }

  async restore(workflowId: string, userId: string): Promise<boolean> {
    // Restore soft-deleted workflow
    const now = new Date();

    const result = await this.db
      .update(workflow)
      .set({
        deleted: false,
        deletedAt: null,
        deletedBy: null,
        updatedAt: now,
      })
      .where(
        and(eq(workflow.id, workflowId), eq(workflow.userId, userId), eq(workflow.deleted, true)),
      );

    return result.changes > 0;
  }

  async listDeleted(userId: string): Promise<WorkflowInfo[]> {
    // List only deleted workflows owned by user
    const rows = await this.db
      .select({
        id: workflow.id,
        slug: workflow.slug,
        userId: workflow.userId,
        ownerHandle: user.handle,
        visibility: workflow.visibility,
        graph: workflow.graph,
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt,
        isValid: workflow.isValid,
        validationErrors: workflow.validationErrors,
        validatedAt: workflow.validatedAt,
      })
      .from(workflow)
      .leftJoin(user, eq(workflow.userId, user.id))
      .where(and(eq(workflow.userId, userId), eq(workflow.deleted, true)))
      .orderBy(workflow.deletedAt);

    return rows.map((row) => {
      const graph = JSON.parse(row.graph) as WorkflowGraph;
      return {
        id: row.id,
        slug: row.slug,
        userId: row.userId,
        ownerHandle: row.ownerHandle || "unknown",
        visibility: row.visibility as "public" | "private",
        accessType: "owner" as const, // Deleted workflows are always owned by user
        metadata: graph.metadata,
        storagePath: `database:workflow:${row.id}`,
        size: row.graph.length,
        createdAt: row.createdAt ? (row.createdAt as Date).getTime() : Date.now(),
        updatedAt: row.updatedAt ? (row.updatedAt as Date).getTime() : Date.now(),
        workflow: graph,
        validation: parseValidationCache(row.isValid, row.validationErrors, row.validatedAt),
      };
    });
  }

  async listAllDeleted(): Promise<
    Array<{
      id: string;
      name: string;
      deletedAt: number | null;
      deletedBy: string | null;
    }>
  > {
    // List ALL deleted workflows (admin) with name, deletedAt, deletedBy
    const rows = await this.db
      .select({
        id: workflow.id,
        name: workflow.name,
        deletedAt: workflow.deletedAt,
        deletedBy: workflow.deletedBy,
      })
      .from(workflow)
      .where(eq(workflow.deleted, true))
      .orderBy(workflow.deletedAt);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      deletedAt: row.deletedAt ? (row.deletedAt as Date).getTime() : null,
      deletedBy: row.deletedBy,
    }));
  }

  /**
   * List all deleted workflows with server-side search, sort, and pagination.
   */
  async listAllDeletedPaginated(filter: {
    search?: string;
    sort?: "name" | "deletedAt";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<{
      id: string;
      name: string;
      deletedAt: number | null;
      deletedBy: string | null;
    }>;
    total: number;
  }> {
    const conditions = [eq(workflow.deleted, true)];

    if (filter.search) {
      const pattern = `%${filter.search}%`;
      conditions.push(or(like(workflow.name, pattern), like(workflow.id, pattern))!);
    }

    const { rows, total } = await executeListQuery(
      this.db,
      DELETED_WORKFLOW_LIST_CONFIG,
      {
        sort: filter.sort,
        sortOrder: filter.sortOrder,
        limit: filter.limit,
        offset: filter.offset,
      },
      conditions,
      {
        id: workflow.id,
        name: workflow.name,
        deletedAt: workflow.deletedAt,
        deletedBy: workflow.deletedBy,
      },
    );

    return {
      items: rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        name: row.name as string,
        deletedAt: row.deletedAt ? (row.deletedAt as Date).getTime() : null,
        deletedBy: row.deletedBy as string | null,
      })),
      total,
    };
  }

  /**
   * List ALL workflows for admin panel with filters, pagination, and owner info.
   * No userId ownership constraint — returns workflows from all users.
   */
  async listAllWorkflowsPaginated(filter: AdminWorkflowFilter): Promise<AdminWorkflowListResult> {
    // Exclude deleted workflows
    const conditions: (SQL | undefined)[] = [
      or(eq(workflow.deleted, false), isNull(workflow.deleted)),
    ];

    // Optional owner filter
    if (filter.userId) {
      conditions.push(eq(workflow.userId, filter.userId));
    }

    // Visibility filter
    if (filter.visibility && filter.visibility !== "all") {
      conditions.push(eq(workflow.visibility, filter.visibility));
    }

    // Validation status filter
    if (filter.isValid !== undefined && filter.isValid !== null) {
      conditions.push(eq(workflow.isValid, filter.isValid));
    } else if (filter.isValid === null) {
      conditions.push(isNull(workflow.isValid));
    }

    // Search filter — search in slug, name, description
    if (filter.search) {
      const pattern = `%${filter.search}%`;
      conditions.push(
        or(
          like(workflow.slug, pattern),
          like(workflow.name, pattern),
          like(workflow.description, pattern),
        ),
      );
    }

    // Date range filter on updatedAt
    if (filter.fromDate) {
      conditions.push(sql`${workflow.updatedAt} >= ${filter.fromDate}`);
    }
    if (filter.toDate) {
      conditions.push(sql`${workflow.updatedAt} <= ${filter.toDate}`);
    }

    const validConditions = conditions.filter((c): c is SQL => c !== undefined);
    const whereClause = validConditions.length > 0 ? and(...validConditions) : undefined;

    // COUNT
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(workflow)
      .where(whereClause);
    const total = countResult[0]?.count ?? 0;

    // SORT
    const sortField = filter.sort ?? "updatedAt";
    const sortColumn =
      ADMIN_WORKFLOW_LIST_CONFIG.sortableColumns[sortField] ??
      ADMIN_WORKFLOW_LIST_CONFIG.sortableColumns.updatedAt;
    const orderFn = (filter.sortOrder ?? "desc") === "asc" ? asc : desc;

    // PAGINATION
    const limit = Math.min(
      Math.max(1, filter.limit ?? ADMIN_WORKFLOW_LIST_CONFIG.defaultLimit),
      ADMIN_WORKFLOW_LIST_CONFIG.maxLimit,
    );
    const offset = Math.max(0, filter.offset ?? 0);

    // SELECT with LEFT JOIN for owner handle
    const rows = await this.db
      .select({
        id: workflow.id,
        slug: workflow.slug,
        userId: workflow.userId,
        ownerHandle: user.handle,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        visibility: workflow.visibility,
        nodeCount: sql<number>`json_array_length(json_extract(${workflow.graph}, '$.nodes'))`,
        createdAt: workflow.createdAt,
        updatedAt: workflow.updatedAt,
        isValid: workflow.isValid,
        validationErrors: workflow.validationErrors,
        validatedAt: workflow.validatedAt,
      })
      .from(workflow)
      .leftJoin(user, eq(workflow.userId, user.id))
      .where(whereClause)
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset);

    const workflows: AdminWorkflowInfo[] = rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      userId: row.userId,
      ownerHandle: row.ownerHandle || "unknown",
      name: row.name,
      description: row.description,
      version: row.version,
      visibility: row.visibility as "public" | "private",
      nodeCount: row.nodeCount ?? 0,
      validation: parseValidationCache(row.isValid, row.validationErrors, row.validatedAt),
      createdAt: row.createdAt ? (row.createdAt as Date).getTime() : Date.now(),
      updatedAt: row.updatedAt ? (row.updatedAt as Date).getTime() : Date.now(),
    }));

    return { workflows, total };
  }

  /**
   * Update workflow visibility
   * Only owner can change visibility
   */
  async updateVisibility(
    workflowId: string,
    userId: string,
    visibility: "public" | "private",
  ): Promise<boolean> {
    const now = new Date();

    const result = await this.db
      .update(workflow)
      .set({
        visibility,
        updatedAt: now,
      })
      .where(
        and(
          eq(workflow.id, workflowId),
          eq(workflow.userId, userId),
          or(eq(workflow.deleted, false), isNull(workflow.deleted)),
        ),
      );

    return result.changes > 0;
  }

  // ===== Validation Cache Operations (Issue #463) =====

  /**
   * Update validation cache for a workflow
   * Called by WorkflowMutationService after validating a workflow
   * @param workflowId - Workflow ID to update
   * @param isValid - Whether the workflow graph is valid
   * @param errors - Array of validation error messages (empty if valid)
   * @returns true if update succeeded
   */
  async updateValidationCache(
    workflowId: string,
    isValid: boolean,
    errors: string[],
  ): Promise<boolean> {
    const now = new Date();

    const result = await this.db
      .update(workflow)
      .set({
        isValid,
        validationErrors: JSON.stringify(errors),
        validatedAt: now,
      })
      .where(eq(workflow.id, workflowId));

    return result.changes > 0;
  }

  /**
   * Get workflows with unknown validation status (isValid = null)
   * Used by migration logic to validate existing workflows
   * @param limit - Maximum number of workflows to return
   * @returns Array of workflow IDs and their graphs
   */
  async getUnvalidatedWorkflows(
    limit: number = 100,
  ): Promise<Array<{ id: string; graph: WorkflowGraph }>> {
    const rows = await this.db
      .select({
        id: workflow.id,
        graph: workflow.graph,
      })
      .from(workflow)
      .where(
        and(isNull(workflow.isValid), or(eq(workflow.deleted, false), isNull(workflow.deleted))),
      )
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      graph: JSON.parse(row.graph) as WorkflowGraph,
    }));
  }

  /**
   * Get validation status for a specific workflow
   * @param workflowId - Workflow ID
   * @returns Validation cache or null if workflow not found
   */
  async getValidationCache(workflowId: string): Promise<ValidationCache | null> {
    const [row] = await this.db
      .select({
        isValid: workflow.isValid,
        validationErrors: workflow.validationErrors,
        validatedAt: workflow.validatedAt,
      })
      .from(workflow)
      .where(eq(workflow.id, workflowId))
      .limit(1);

    if (!row) {
      return null;
    }

    return parseValidationCache(row.isValid, row.validationErrors, row.validatedAt);
  }
}
