/**
 * Playbooks: named, reusable behaviour text that workflow nodes reference by name.
 *
 * The service owns the rules a playbook has beyond storage — who may read it, who may change it,
 * who may publish it, and what each of those writes into the audit trail. Access is never decided
 * here: every question goes to the central authorization policy, so a playbook is governed by the
 * same rules as a workflow or a run.
 *
 * Publishing is deliberately a separate permission from editing. Making somebody's playbook visible
 * to everyone is an act of sharing, not an edit, and only a subject who may share the resource can
 * do it.
 */

import { AuditAction } from "../audit/actions.js";
import { logAuditEventDirect } from "../logging/audit-logger.js";
import { createLogger } from "../logging/logger.js";
import { ValidationError } from "../errors/index.js";
import type { AuditRepository } from "../database/repositories/audit-repository.js";
import {
  MAX_PLAYBOOK_SIZE,
  type Playbook,
  type PlaybookListResult,
  type PlaybookRepository,
  type PlaybookSummary,
  type PlaybookVisibility,
} from "../database/repositories/playbook-repository.js";
import type { RevisionSummary } from "../database/repositories/revision-repository.js";
import type { RevisionDiffPart } from "./revision-diff.js";
import { RESOURCE_TYPES } from "../authorization/authorization-policy.js";
import type { AuthorizationService } from "../authorization/authorization-service.js";
import type { UserRepository } from "../database/repositories/user-repository.js";

/** Machine names are what a workflow node references, so they stay simple and predictable. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;

export class PlaybookService {
  private logger = createLogger({ component: "PlaybookService" });

  constructor(
    private playbookRepo: PlaybookRepository,
    private auditRepo: AuditRepository,
    private authorization: AuthorizationService,
    private userRepo: UserRepository,
  ) {}

  /**
   * Whose playbooks are meant.
   *
   * A reference lives inside one account, so reading somebody else's public playbook means naming
   * them; a handle is accepted because that is how users refer to each other everywhere else.
   */
  async resolveOwner(owner: string | undefined, userId: string): Promise<string | null> {
    if (!owner) return userId;
    const handle = owner.replace(/^@/, "");
    const byHandle = await this.userRepo.resolveHandle(handle);
    if (byHandle) return byHandle;
    // A user id is accepted too: an agent that already holds one should not have to look up a
    // handle for it.
    const account = await this.userRepo.getHandle(owner);
    return account ? owner : null;
  }

  /** Playbooks this user owns. */
  async list(
    userId: string,
    options: { search?: string; limit?: number; offset?: number } = {},
  ): Promise<PlaybookListResult> {
    return this.playbookRepo.list({ ownerId: userId, ...options });
  }

  /**
   * Read a playbook, optionally at a past revision.
   *
   * `ownerId` names whose playbook is meant: a reference resolves within one owner, and a public
   * playbook is readable by anybody who is signed in.
   */
  async get(
    userId: string,
    ownerId: string,
    slug: string,
    revision?: number,
  ): Promise<Playbook | null> {
    const found = await this.playbookRepo.get(ownerId, slug, revision);
    if (!found) return null;
    return (await this.may(userId, "view", found)) ? found : null;
  }

  /** Create a playbook or write a new revision of one. */
  async save(
    userId: string,
    options: {
      ownerId?: string;
      slug: string;
      content: string;
      name?: string;
      description?: string | null;
    },
  ): Promise<{ id: string; revision: number; created: boolean }> {
    const ownerId = options.ownerId ?? userId;
    if (!SLUG_PATTERN.test(options.slug)) {
      throw new ValidationError(
        "A playbook name uses lower-case letters, digits and hyphens, 3 to 80 characters, and starts with a letter or digit",
      );
    }
    const size = Buffer.byteLength(options.content, "utf8");
    if (size > MAX_PLAYBOOK_SIZE) {
      throw new ValidationError(
        `A playbook holds at most ${MAX_PLAYBOOK_SIZE} bytes; this one is ${size}`,
      );
    }

    const existing = await this.playbookRepo.get(ownerId, options.slug);
    if (existing && !(await this.may(userId, "edit", existing))) {
      throw new ValidationError("This playbook belongs to another user");
    }
    if (!existing && ownerId !== userId) {
      throw new ValidationError("A playbook is created in its owner's account");
    }

    const saved = await this.playbookRepo.save({
      ownerId,
      slug: options.slug,
      content: options.content,
      name: options.name,
      description: options.description,
      authorId: userId,
    });

    await logAuditEventDirect(this.auditRepo, {
      userId,
      action: existing ? AuditAction.PLAYBOOK_UPDATE : AuditAction.PLAYBOOK_CREATE,
      resource: "playbook",
      resourceId: saved.id,
      metadata: { slug: options.slug, revision: saved.revision, ownerId },
    });

    return { ...saved, created: !existing };
  }

  /**
   * Publish a playbook or make it private again.
   *
   * Requires the right to share, not merely to edit: publishing hands the content to everyone, and
   * that is the owner's decision rather than an editor's.
   */
  async setVisibility(
    userId: string,
    ownerId: string,
    slug: string,
    visibility: PlaybookVisibility,
  ): Promise<PlaybookSummary> {
    const existing = await this.playbookRepo.get(ownerId, slug);
    if (!existing) throw new ValidationError(`Playbook '${slug}' does not exist`);
    if (!(await this.may(userId, "share", existing))) {
      throw new ValidationError("Only the owner decides who may read a playbook");
    }

    await this.playbookRepo.setVisibility(existing.id, visibility);
    await logAuditEventDirect(this.auditRepo, {
      userId,
      action: AuditAction.PLAYBOOK_VISIBILITY,
      resource: "playbook",
      resourceId: existing.id,
      metadata: { slug, visibility },
      changes: [{ field: "visibility", oldValue: existing.visibility, newValue: visibility }],
    });

    const updated = await this.playbookRepo.getById(existing.id);
    if (!updated) throw new ValidationError(`Playbook '${slug}' does not exist`);
    return updated;
  }

  /** Remove a playbook and its history. */
  async remove(userId: string, ownerId: string, slug: string): Promise<boolean> {
    const existing = await this.playbookRepo.get(ownerId, slug);
    if (!existing) return false;
    if (!(await this.may(userId, "delete", existing))) {
      throw new ValidationError("Only the owner removes a playbook");
    }

    const removed = await this.playbookRepo.remove(existing.id);
    if (removed) {
      await logAuditEventDirect(this.auditRepo, {
        userId,
        action: AuditAction.PLAYBOOK_DELETE,
        resource: "playbook",
        resourceId: existing.id,
        metadata: { slug, ownerId },
      });
    }
    return removed;
  }

  /** Version history of a playbook. */
  async history(userId: string, ownerId: string, slug: string): Promise<RevisionSummary[]> {
    const existing = await this.playbookRepo.get(ownerId, slug);
    if (!existing || !(await this.may(userId, "view", existing))) return [];
    return this.playbookRepo.history(existing.id);
  }

  /** Compare two revisions of a playbook. */
  async compare(
    userId: string,
    ownerId: string,
    slug: string,
    from: number,
    to: number,
  ): Promise<{ from: number; to: number; parts: RevisionDiffPart[] } | null> {
    const existing = await this.playbookRepo.get(ownerId, slug);
    if (!existing || !(await this.may(userId, "view", existing))) return null;
    return this.playbookRepo.compare(existing.id, from, to);
  }

  /**
   * Put a past revision back in force.
   *
   * Restoring writes a new revision carrying the old content, so the history keeps both what the
   * text was and the decision to return to it.
   */
  async restore(
    userId: string,
    ownerId: string,
    slug: string,
    revision: number,
  ): Promise<{ id: string; revision: number } | null> {
    const existing = await this.playbookRepo.get(ownerId, slug);
    if (!existing) return null;
    if (!(await this.may(userId, "edit", existing))) {
      throw new ValidationError("This playbook belongs to another user");
    }
    const past = await this.playbookRepo.get(ownerId, slug, revision);
    if (!past) return null;

    const saved = await this.playbookRepo.save({
      ownerId,
      slug,
      content: past.content,
      authorId: userId,
    });
    await logAuditEventDirect(this.auditRepo, {
      userId,
      action: AuditAction.PLAYBOOK_RESTORE,
      resource: "playbook",
      resourceId: saved.id,
      metadata: { slug, restoredFrom: revision, revision: saved.revision },
    });
    this.logger.debug("restore() wrote a revision", { slug, revision: saved.revision });
    return saved;
  }

  private async may(
    userId: string,
    action: "view" | "use" | "edit" | "delete" | "share",
    target: PlaybookSummary,
  ): Promise<boolean> {
    return this.authorization.can(userId, action, {
      type: RESOURCE_TYPES.playbook,
      id: target.id,
      ownerId: target.ownerId,
      visibility: target.visibility,
    });
  }
}
