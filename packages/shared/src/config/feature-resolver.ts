/**
 * Feature Resolver
 *
 * Single seam for "is this feature enabled for this context?" decisions
 * (the Sentry pattern: one code path, a swappable resolver).
 *
 * The default resolver is driven by DEPLOYMENT_MODE: SaaS-specific behaviors
 * are off in `self-host` and on in `saas`. A future cloud build can swap in a
 * richer resolver (per-plan / per-tenant) via {@link setFeatureResolver} without
 * touching call sites.
 *
 * Unknown features resolve to `false` (safe default): a behavior that has not
 * been explicitly enabled stays off.
 */

import type { DeploymentMode } from "./env.js";
import { getDeploymentMode } from "./env.js";

/**
 * Feature flags gated by deployment mode.
 *
 * These are SaaS-scaffolding behaviors that a self-host install does not want
 * by default. Security-relevant fixes that are mode-independent (PIN hashing,
 * IPv6 rate-limit) are NOT feature flags — they always apply.
 */
export type Feature =
  /** Public self-service registration is open. */
  | "openRegistration"
  /** Email verification is a hard gate for issuing app/API tokens. */
  | "emailVerificationGate"
  /** Send a verification email automatically on sign-up. */
  | "verificationEmailOnSignup"
  /** Require legal consents (terms + residency) at registration. */
  | "legalConsents"
  /** Show beta agreement modal/banner in the UI. */
  | "betaNotices"
  /** Expose multi-user admin pages (user management, all executions, etc.). */
  | "multiUserAdmin"
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
 * Which SaaS features are on in each mode. `self-host` is the safe baseline:
 * all SaaS scaffolding off. `saas` turns them all on.
 */
const MODE_FEATURES: Record<DeploymentMode, Record<Feature, boolean>> = {
  "self-host": {
    openRegistration: false,
    emailVerificationGate: false,
    verificationEmailOnSignup: false,
    legalConsents: false,
    betaNotices: false,
    multiUserAdmin: false,
    socialLogin: false,
  },
  saas: {
    openRegistration: true,
    emailVerificationGate: true,
    verificationEmailOnSignup: true,
    legalConsents: true,
    betaNotices: true,
    multiUserAdmin: true,
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
