export type AdmissionRouteDecision = "allow" | "pending-approval" | "verify-email";

export interface AdmissionRouteState {
  accountApprovalRequired: boolean;
  accountApproved: boolean;
  emailVerificationGate: boolean;
  emailVerified: boolean;
}

/**
 * Keep approval and email ownership as independent browser-routing concerns.
 * The server remains authoritative; this decision only guides authenticated
 * users to the matching status page before rendering protected content.
 */
export function decideAdmissionRoute(state: AdmissionRouteState): AdmissionRouteDecision {
  if (state.accountApprovalRequired && !state.accountApproved) {
    return "pending-approval";
  }
  if (state.emailVerificationGate && !state.emailVerified) {
    return "verify-email";
  }
  return "allow";
}

export type RegistrationCompletionMode = "loading" | "approval" | "email-verification";

export function getRegistrationCompletionMode(
  featuresLoaded: boolean,
  accountApprovalEnabled: boolean,
): RegistrationCompletionMode {
  if (!featuresLoaded) return "loading";
  return accountApprovalEnabled ? "approval" : "email-verification";
}
