/**
 * Feature Resolver
 *
 * Single seam for "is this feature enabled for this context?" decisions
 * (the Sentry pattern: one code path, a swappable resolver).
 *
 * The default resolver composes capabilities from DEPLOYMENT_MODE. Self-host and
 * SaaS share some capabilities but choose different admission, verification,
 * legal, and administrator policies. A future cloud build can swap in a richer
 * resolver (per-plan / per-tenant) via {@link setFeatureResolver} without touching
 * call sites.
 *
 * Unknown features resolve to `false` (safe default): a behavior that has not
 * been explicitly enabled stays off.
 */

import type { DeploymentMode } from "./env.js";
import { getDeploymentMode } from "./env.js";

/**
 * Feature flags gated by deployment mode.
 *
 * These capabilities describe deployment-specific policy, including features
 * shared by both modes and deliberately different admission/admin boundaries.
 * Security fixes that are mode-independent (PIN hashing, IPv6 rate-limit) are
 * NOT feature flags — they always apply.
 */
export type Feature =
  /** Public self-service registration is open. */
  | "openRegistration"
  /** Require an administrator to approve a new account before product access. */
  | "accountApproval"
  /** Email verification is a hard gate for issuing app/API tokens. */
  | "emailVerificationGate"
  /** Send a verification email automatically on sign-up. */
  | "verificationEmailOnSignup"
  /** Require legal consents (terms + residency) at registration. */
  | "legalConsents"
  /** Show beta agreement modal/banner in the UI. */
  | "betaNotices"
  /** Expose broad multi-user admin pages such as all executions and workflows. */
  | "multiUserAdmin"
  /** Expose user-management capabilities independently of broader admin pages. */
  | "userManagement"
  /** Expose aggregate administrator analytics across the hosted installation. */
  | "adminAnalytics"
  /** Expose operational dashboards backed by installation-wide telemetry. */
  | "adminOperations"
  /** Allow deliberate monitoring/development side effects such as test errors and delays. */
  | "operationsDevelopment"
  /** Offer GitHub/Google social (OAuth) login. */
  | "socialLogin";

/**
 * Optional context for a feature decision. Reserved for future per-user /
 * per-tenant resolution (cloud); the default resolver ignores it.
 */
export interface FeatureContext {
  userId?: string;
}

export interface FeatureResolver {
  /**
   * Resolve whether a feature is enabled for the given context.
   * Unknown features resolve to `false`.
   */
  isEnabled(feature: Feature, ctx?: FeatureContext): boolean;
}

/**
 * Complete capability composition for each deployment mode. Self-host opens
 * registration behind administrator approval and exposes only the narrow user
 * management surface; SaaS keeps its legal/email gates and broad admin surface.
 */
const MODE_FEATURES: Record<DeploymentMode, Record<Feature, boolean>> = {
  "self-host": {
    openRegistration: true,
    accountApproval: true,
    emailVerificationGate: false,
    verificationEmailOnSignup: false,
    legalConsents: false,
    betaNotices: false,
    multiUserAdmin: false,
    userManagement: true,
    adminAnalytics: false,
    adminOperations: false,
    operationsDevelopment: false,
    socialLogin: false,
  },
  saas: {
    openRegistration: true,
    accountApproval: false,
    emailVerificationGate: true,
    verificationEmailOnSignup: true,
    legalConsents: true,
    betaNotices: true,
    multiUserAdmin: true,
    userManagement: true,
    adminAnalytics: true,
    adminOperations: true,
    operationsDevelopment: true,
    socialLogin: true,
  },
};

/**
 * Default resolver: decides purely from the current DEPLOYMENT_MODE.
 */
export class ModeFeatureResolver implements FeatureResolver {
  isEnabled(feature: Feature, _ctx?: FeatureContext): boolean {
    const mode = getDeploymentMode();
    const flags = MODE_FEATURES[mode];
    // Unknown feature → safe default off.
    return flags?.[feature] ?? false;
  }
}
