/**
 * The one place that decides whether a subject may act on a resource.
 *
 * Every entity that used to compare `userId` and check `visibility` for itself asks this instead,
 * so "who may do what" is one decision rather than a rule per table. The policy is pure: callers
 * resolve the subject, the resource and any grant, and this module only judges them.
 */

/** Kinds of resource the policy knows how to judge. */
export const RESOURCE_TYPES = {
  workflow: "workflow",
  execution: "execution",
  note: "note",
  artifact: "artifact",
  playbook: "playbook",
} as const;

export type ResourceType = (typeof RESOURCE_TYPES)[keyof typeof RESOURCE_TYPES];

/**
 * What a subject wants to do.
 *
 * `view` reads the resource, `use` acts with it without changing it (starting a workflow, reading a
 * playbook into a step), `edit` changes it, `delete` removes it, `share` grants someone else
 * access, and `administer` covers operator actions on somebody else's resource.
 */
export type AuthorizationAction = "view" | "use" | "edit" | "delete" | "share" | "administer";

/**
 * Level of an explicit grant.
 *
 * `use` is what an accepted invite gives today — read and act, but not change. `edit` additionally
 * allows changing the resource; nothing issues it yet, and the policy already honours it so the
 * next feature does not have to reopen this decision.
 */
export type GrantLevel = "use" | "edit";

/** Who is acting. Groups are part of the model; nothing populates them yet. */
export interface AuthorizationSubject {
  userId: string;
  /** Operator of the installation. */
  isAdmin?: boolean;
  /** Groups the user belongs to, used to resolve grants made to a group. */
  groupIds?: string[];
}

/** What is being acted on. */
export interface AuthorizationResource {
  type: ResourceType;
  id: string;
  /** Owning user id, or a system owner id for bundled catalog content. */
  ownerId: string;
  visibility?: "private" | "public";
}

/** An explicit grant that applies to this subject and resource, when one exists. */
export interface AccessGrant {
  level: GrantLevel;
}

const OWNER_ACTIONS: readonly AuthorizationAction[] = [
  "view",
  "use",
  "edit",
  "delete",
  "share",
  "administer",
];
const PUBLIC_ACTIONS: readonly AuthorizationAction[] = ["view", "use"];
const GRANT_ACTIONS: Record<GrantLevel, readonly AuthorizationAction[]> = {
  use: ["view", "use"],
  edit: ["view", "use", "edit"],
};

/**
 * Decide one action.
 *
 * The owner may do anything with their own resource. A public resource may be read and used by any
 * authenticated subject, but never changed by a stranger: publishing shares content, not control.
 * Anything else needs an explicit grant, and the grant's level says how far it goes.
 *
 * An administrator gets `administer` on anybody's resource and nothing more. Operating the
 * installation is not the same as acting as the user: if `isAdmin` also granted `use`, an
 * operator's own agent session would silently be able to drive other people's runs, which is a
 * wider power than any operator task needs.
 */
export function decideAccess(
  subject: AuthorizationSubject,
  action: AuthorizationAction,
  resource: AuthorizationResource,
  grant?: AccessGrant | null,
): boolean {
  if (subject.userId === resource.ownerId) return OWNER_ACTIONS.includes(action);
  if (subject.isAdmin && action === "administer") return true;
  if (resource.visibility === "public" && PUBLIC_ACTIONS.includes(action)) return true;
  if (grant) return GRANT_ACTIONS[grant.level].includes(action);
  return false;
}
