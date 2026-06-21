/**
 * User normalizer
 * Maps 2 different user interfaces to a single normalized shape
 */

export interface NormalizedUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  createdAt: string;
  workflowsCount: number;
  emailVerified?: boolean;
  blocked?: boolean;
}

interface UserManagementUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  emailVerified: boolean;
  blocked: boolean;
  createdAt: string;
  workflowsCount: number;
}

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  createdAt: string;
  workflowsCount: number;
}

type AnyUser = UserManagementUser | AdminUser;

export function normalizeUser(user: AnyUser): NormalizedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt,
    workflowsCount: user.workflowsCount,
    emailVerified: "emailVerified" in user ? user.emailVerified : undefined,
    blocked: "blocked" in user ? user.blocked : undefined,
  };
}
