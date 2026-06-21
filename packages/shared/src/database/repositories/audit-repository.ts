/**
 * Audit Repository - Domain repository for audit log
 * Drizzle ORM queries for audit trail operations
 */

import { eq, and, count, gte, lte, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { auditLog } from "../schema.js";
import { createLogger } from "../../logging/logger.js";
import type * as schema from "../schema.js";
import { randomUUID } from "crypto";
import { executeListQuery, type ListQueryConfig } from "../list-query-builder.js";

const AUDIT_LIST_CONFIG: ListQueryConfig<"createdAt" | "action" | "resource" | "source"> = {
  table: auditLog,
  sortableColumns: {
    createdAt: auditLog.createdAt,
    action: auditLog.action,
    resource: auditLog.resource,
    source: auditLog.source,
  },
  defaultSort: { field: "createdAt", order: "desc" },
  defaultLimit: 50,
  maxLimit: 100,
};

export interface AuditChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface AuditLogEntry {
  id: string;
  userId?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  source?: string; // 'mcp' | 'web' | 'api' | 'system'
  ip?: string;
  country?: string;
  userAgent?: string;
  metadata?: string;
  changes?: string; // JSON array of AuditChange
  createdAt: number;
}

export interface AuditLogFilter {
  userId?: string;
  action?: string | string[];
  resource?: string;
  resourceId?: string;
  source?: string;
  fromDate?: number;
  toDate?: number;
  sortBy?: "createdAt" | "action" | "resource" | "source";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export class AuditRepository {
  private logger = createLogger({ component: "AuditRepository" });

  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  async log(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<string> {
    const id = randomUUID();
    const now = new Date();

    await this.db.insert(auditLog).values({
      id,
      userId: entry.userId || null,
      action: entry.action,
      resource: entry.resource || null,
      resourceId: entry.resourceId || null,
      source: entry.source || null,
      ip: entry.ip || null,
      country: entry.country || null,
      userAgent: entry.userAgent || null,
      metadata: entry.metadata || null,
      changes: entry.changes || null,
      createdAt: now,
    });

    this.logger.info("Audit log entry created", {
      id,
      action: entry.action,
      userId: entry.userId,
      source: entry.source,
    });
    return id;
  }

  private buildConditions(filter: AuditLogFilter) {
    const conditions = [];
    if (filter.userId) conditions.push(eq(auditLog.userId, filter.userId));
    if (filter.action) {
      if (Array.isArray(filter.action)) {
        if (filter.action.length > 0) conditions.push(inArray(auditLog.action, filter.action));
      } else {
        conditions.push(eq(auditLog.action, filter.action));
      }
    }
    if (filter.resource) conditions.push(eq(auditLog.resource, filter.resource));
    if (filter.resourceId) conditions.push(eq(auditLog.resourceId, filter.resourceId));
    if (filter.source) conditions.push(eq(auditLog.source, filter.source));
    if (filter.fromDate) conditions.push(gte(auditLog.createdAt, new Date(filter.fromDate)));
    if (filter.toDate) conditions.push(lte(auditLog.createdAt, new Date(filter.toDate)));
    return conditions;
  }

  private mapRow(row: typeof auditLog.$inferSelect): AuditLogEntry {
    return {
      id: row.id,
      userId: row.userId || undefined,
      action: row.action,
      resource: row.resource || undefined,
      resourceId: row.resourceId || undefined,
      source: row.source || undefined,
      ip: row.ip || undefined,
      country: row.country || undefined,
      userAgent: row.userAgent || undefined,
      metadata: row.metadata || undefined,
      changes: row.changes || undefined,
      createdAt: (row.createdAt as Date).getTime(),
    };
  }

  async list(filter: AuditLogFilter = {}): Promise<AuditLogEntry[]> {
    const conditions = this.buildConditions(filter);

    const { rows } = await executeListQuery(
      this.db,
      AUDIT_LIST_CONFIG,
      {
        sort: filter.sortBy,
        sortOrder: filter.sortOrder,
        limit: filter.limit,
        offset: filter.offset,
      },
      conditions,
    );

    return rows.map((row) => this.mapRow(row));
  }

  async listWithTotal(
    filter: AuditLogFilter = {},
  ): Promise<{ entries: AuditLogEntry[]; total: number }> {
    const conditions = this.buildConditions(filter);

    const { rows, total } = await executeListQuery(
      this.db,
      AUDIT_LIST_CONFIG,
      {
        sort: filter.sortBy,
        sortOrder: filter.sortOrder,
        limit: filter.limit,
        offset: filter.offset,
      },
      conditions,
    );

    return { entries: rows.map((row) => this.mapRow(row)), total };
  }

  async get(id: string): Promise<AuditLogEntry | null> {
    const [row] = await this.db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);

    if (!row) {
      return null;
    }

    return this.mapRow(row);
  }

  /**
   * Count audit entries by action and resourceId
   * Used for analytics (e.g., counting execution steps)
   */
  async countByActionAndResourceId(action: string, resourceId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: count() })
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, resourceId)));

    return result?.count ?? 0;
  }
}
