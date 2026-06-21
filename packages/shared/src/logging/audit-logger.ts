/**
 * Audit Logging Helper
 * Simplifies audit trail logging in route handlers
 */

import geoip from "geoip-lite";
import type { Request } from "express";
import type { DatabaseRepository } from "@mcp-moira/workflow-engine";
import type { AuditRepository, AuditLogEntry } from "../database/repositories/audit-repository.js";
import { getAuditSource } from "./context.js";
import { auditActionsTotal } from "../metrics/index.js";

export interface AuditChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface AuditContext {
  userId?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  changes?: AuditChange[];
}

/**
 * Interface for audit logging capability
 * Implemented by both DatabaseRepository (logAudit) and AuditRepository (log)
 */
export interface AuditLogger {
  logAudit?(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<string>;
  log?(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<string>;
}

/**
 * Log audit event from Express request
 * Automatically extracts IP, country, user agent from request
 * Source is automatically determined from global service
 */
export async function logAuditEvent(
  repository: DatabaseRepository,
  req: Request,
  context: AuditContext,
): Promise<void> {
  // Get real IP with proxy support (x-forwarded-for header)
  const ip =
    req.ip ||
    req.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.socket.remoteAddress ||
    undefined;
  const geo = ip ? geoip.lookup(ip) : null;
  const country = geo?.country || undefined;
  const userAgent = req.get("user-agent") || undefined;

  // Get source from global service
  const source = getAuditSource();

  await repository.logAudit({
    userId: context.userId,
    action: context.action,
    resource: context.resource,
    resourceId: context.resourceId,
    source,
    ip,
    country,
    userAgent,
    metadata: context.metadata ? JSON.stringify(context.metadata) : undefined,
    changes: context.changes ? JSON.stringify(context.changes) : undefined,
  });

  // Increment audit metrics
  auditActionsTotal.inc({
    action: context.action,
    resource: context.resource || "unknown",
  });
}

/**
 * Log audit event without request context
 * For background tasks or system operations
 * Source is automatically determined from global service
 *
 * Accepts either:
 * - DatabaseRepository (has logAudit method) - for MCP/web routes
 * - AuditRepository (has log method) - for Services
 */
export async function logAuditEventDirect(
  repository: DatabaseRepository | AuditRepository,
  context: AuditContext & { ip?: string; country?: string; userAgent?: string; source?: string },
): Promise<void> {
  // Get source from global service if not explicitly provided
  const source = context.source || getAuditSource();

  const entry = {
    userId: context.userId,
    action: context.action,
    resource: context.resource,
    resourceId: context.resourceId,
    source,
    ip: context.ip,
    country: context.country,
    userAgent: context.userAgent,
    metadata: context.metadata ? JSON.stringify(context.metadata) : undefined,
    changes: context.changes ? JSON.stringify(context.changes) : undefined,
  };

  // Use appropriate method based on repository type
  if ("logAudit" in repository) {
    await repository.logAudit(entry);
  } else {
    await repository.log(entry);
  }

  // Increment audit metrics
  auditActionsTotal.inc({
    action: context.action,
    resource: context.resource || "unknown",
  });
}

/**
 * Helper to compute diff between two objects
 * Returns array of changes for audit log
 */
export function computeChanges(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  fields?: string[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  const keysToCheck = fields || [...new Set([...Object.keys(oldObj), ...Object.keys(newObj)])];

  for (const field of keysToCheck) {
    const oldValue = oldObj[field];
    const newValue = newObj[field];

    // Deep comparison for objects
    const oldStr = JSON.stringify(oldValue);
    const newStr = JSON.stringify(newValue);

    if (oldStr !== newStr) {
      changes.push({ field, oldValue, newValue });
    }
  }

  return changes;
}
