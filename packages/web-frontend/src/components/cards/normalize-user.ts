/**
 * User normalizer
 * Maps 2 different user interfaces to a single normalized shape
 */

import type { AdminUserActivity } from "@mcp-moira/shared";

export interface NormalizedUser extends Partial<AdminUserActivity> {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  createdAt: string;
  workflowsCount: number;
  emailVerified?: boolean;
  approvedAt?: string | null;
  blocked?: boolean;
}

interface UserManagementUser extends Partial<AdminUserActivity> {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  emailVerified: boolean;
  approvedAt: string | null;
  blocked: boolean;
  createdAt: string;
  workflowsCount: number;
}

interface AdminUser extends Partial<AdminUserActivity> {
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
    lastActivityAt: user.lastActivityAt,
    lastStepAt: user.lastStepAt,
    executionsCount: user.executionsCount,
    topWorkflows: user.topWorkflows,
    emailVerified: "emailVerified" in user ? user.emailVerified : undefined,
    approvedAt: "approvedAt" in user ? user.approvedAt : undefined,
    blocked: "blocked" in user ? user.blocked : undefined,
  };
}
