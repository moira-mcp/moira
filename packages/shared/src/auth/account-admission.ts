import { getFeatureResolver } from "../services/index.js";

export const ACCOUNT_APPROVAL_REQUIRED_CODE = "ACCOUNT_APPROVAL_REQUIRED";

export interface AccountAdmission {
  approvalRequired: boolean;
  approved: boolean;
  admitted: boolean;
}

export type AccountAccessDenial = "blocked" | "approval" | "email-verification" | null;

export interface AccountAccessState {
  userId?: string;
  blocked: boolean;
  approvedAt: string | null | undefined;
  emailVerified: boolean;
}

export interface AccountAccessOptions {
  allowPendingApproval?: boolean;
  requireEmailVerified?: boolean;
}

/**
 * Resolve account admission without conflating it with email verification,
 * administrator role, or blocked status. Use getAccountAccessDenial at access
 * boundaries that must compose approval with blocking or email verification.
 */
export function getAccountAdmission(
  approvedAt: string | null | undefined,
  userId?: string,
): AccountAdmission {
  const approvalRequired = getFeatureResolver().isEnabled("accountApproval", { userId });
  const approved = typeof approvedAt === "string" && approvedAt.length > 0;

  return {
    approvalRequired,
    approved,
    admitted: !approvalRequired || approved,
  };
}

/** Return the first denial in security precedence order. */
export function getAccountAccessDenial(
  state: AccountAccessState,
  options: AccountAccessOptions = {},
): AccountAccessDenial {
  if (state.blocked) return "blocked";

  const admission = getAccountAdmission(state.approvedAt, state.userId);
  if (!options.allowPendingApproval && !admission.admitted) return "approval";

  if (
    options.requireEmailVerified &&
    getFeatureResolver().isEnabled("emailVerificationGate", { userId: state.userId }) &&
    !state.emailVerified
  ) {
    return "email-verification";
  }

  return null;
}
