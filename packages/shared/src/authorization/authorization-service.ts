/**
 * Resolves what the policy needs and answers access questions for the rest of the product.
 *
 * The policy decides; this service supplies the facts it decides on — whether the subject operates
 * the installation, and whether an explicit grant reaches them directly or through a group they
 * belong to. Callers pass the resource they already loaded, so no path re-reads an entity just to
 * ask about it.
 */

import { and, eq, inArray, or } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { accessGrant, principalGroupMember, user } from "../database/schema.js";
import type * as schema from "../database/schema.js";
import {
  decideAccess,
  type AccessGrant,
  type AuthorizationAction,
  type AuthorizationResource,
  type AuthorizationSubject,
  type GrantLevel,
} from "./authorization-policy.js";

export class AuthorizationService {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /** Decide one action for one already-loaded resource. */
  async can(
    userId: string,
    action: AuthorizationAction,
    resource: AuthorizationResource,
  ): Promise<boolean> {
    if (userId === resource.ownerId) return decideAccess({ userId }, action, resource);

    const subject = await this.subject(userId);
    const grant = await this.grantFor(subject, resource);
    return decideAccess(subject, action, resource, grant);
  }

  /**
   * Decide whether any of these actions is allowed.
   *
   * Reading surfaces that serve both the owner and an operator ask for both at once: the owner
   * reads their own run, the operator inspects somebody else's. Asking once keeps the two answers
   * one decision instead of an `isAdmin` branch beside every check.
   */
  async canAny(
    userId: string,
    actions: AuthorizationAction[],
    resource: AuthorizationResource,
  ): Promise<boolean> {
    const subject = await this.subject(userId);
    const grant = await this.grantFor(subject, resource);
    return actions.some((action) => decideAccess(subject, action, resource, grant));
  }

  /** The subject as the policy sees it: the acting user, their operator status and their groups. */
  async subject(userId: string): Promise<AuthorizationSubject> {
    const [account] = await this.db
      .select({ isAdmin: user.isAdmin })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    const memberships = await this.db
      .select({ groupId: principalGroupMember.groupId })
      .from(principalGroupMember)
      .where(eq(principalGroupMember.userId, userId));

    return {
      userId,
      isAdmin: account?.isAdmin === true,
      groupIds: memberships.map((row) => row.groupId),
    };
  }

  /**
   * The strongest grant that reaches this subject for this resource, or null.
   *
   * A grant made to a group the subject belongs to counts exactly as much as one made to them
   * directly; where both exist, the wider level wins.
   */
  async grantFor(
    subject: AuthorizationSubject,
    resource: AuthorizationResource,
  ): Promise<AccessGrant | null> {
    const groupIds = subject.groupIds ?? [];
    const reachesSubject = groupIds.length
      ? or(eq(accessGrant.userId, subject.userId), inArray(accessGrant.groupId, groupIds))
      : eq(accessGrant.userId, subject.userId);

    const rows = await this.db
      .select({ level: accessGrant.level })
      .from(accessGrant)
      .where(
        and(
          eq(accessGrant.resourceType, resource.type),
          eq(accessGrant.resourceId, resource.id),
          reachesSubject,
        ),
      );

    if (rows.length === 0) return null;
    const level: GrantLevel = rows.some((row) => row.level === "edit") ? "edit" : "use";
    return { level };
  }
}
