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
  /** Durable idempotency key for events whose retries must collapse at the audit sink. */
  dedupeKey?: string;
}

export interface AuditRequestContext {
  source?: string;
  ip?: string;
  country?: string;
  userAgent?: string;
}

export function getAuditRequestContext(req: Request): AuditRequestContext {
  // req.ip is resolved through the trusted proxies (TRUST_PROXY); X-Forwarded-For itself is not trusted.
  const ip = req.ip || req.socket.remoteAddress || undefined;
  const geo = ip ? geoip.lookup(ip) : null;

  return {
    source: getAuditSource(),
    ip,
    country: geo?.country || undefined,
    userAgent: req.get("user-agent") || undefined,
  };
}

export function recordAuditEventMetric(action: string, resource?: string): void {
  auditActionsTotal.inc({
    action,
    resource: resource || "unknown",
  });
}

/**
 * Interface for audit logging capability
 * Implemented by both DatabaseRepository (logAudit) and AuditRepository (log)
 */
export interface AuditLogger {
  logAudit?(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<string>;
  log?(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<string>;
  logOnce?(
    entry: Omit<AuditLogEntry, "id" | "createdAt" | "dedupeKey"> & { dedupeKey: string },
  ): Promise<{ id: string; inserted: boolean }>;
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
  const { ip, country, userAgent, source } = getAuditRequestContext(req);

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

  recordAuditEventMetric(context.action, context.resource);
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
async function writeAuditEventDirect(
  repository: DatabaseRepository | AuditRepository,
  context: AuditContext & { ip?: string; country?: string; userAgent?: string; source?: string },
): Promise<boolean> {
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
  let inserted = true;
  if (context.dedupeKey !== undefined && "logOnce" in repository) {
    inserted = (await repository.logOnce({ ...entry, dedupeKey: context.dedupeKey })).inserted;
  } else if ("logAudit" in repository) {
    await repository.logAudit(entry);
  } else {
    await repository.log(entry);
  }

  if (inserted) {
    recordAuditEventMetric(context.action, context.resource);
  }
  return inserted;
}

export async function logAuditEventDirect(
  repository: DatabaseRepository | AuditRepository,
  context: AuditContext & { ip?: string; country?: string; userAgent?: string; source?: string },
): Promise<void> {
  await writeAuditEventDirect(repository, context);
}

/**
 * Write an audit event with a durable idempotency key and report whether this call inserted it.
 * This narrower API lets a domain metric follow the same exactly-once boundary as the audit row.
 */
export async function logAuditEventDirectOnce(
  repository: AuditRepository,
  context: AuditContext & {
    dedupeKey: string;
    ip?: string;
    country?: string;
    userAgent?: string;
    source?: string;
  },
): Promise<boolean> {
  return writeAuditEventDirect(repository, context);
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
