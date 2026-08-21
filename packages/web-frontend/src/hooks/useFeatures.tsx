/**
 * Feature flags provider.
 *
 * Loads deployment mode + feature flags from the public `GET /api/features`
 * endpoint once at app startup and exposes them via context so SaaS-specific UI
 * can be hidden in self-host installs.
 *
 * Default while loading / on error: every flag is `false` (self-host baseline).
 * Consumers that must choose between deployment-specific security or admission
 * flows also receive the distinct error state and an explicit retry action.
 */

import { createContext, useContext, useEffect, useState } from "react";
import { apiClient } from "../services/api-client";
import type { DeploymentMode, FeatureFlag, FeaturesResponse } from "../types/api-types";

type FeatureFlags = Record<FeatureFlag, boolean>;

const ALL_OFF: FeatureFlags = {
  openRegistration: false,
  accountApproval: false,
  emailVerificationGate: false,
  verificationEmailOnSignup: false,
  legalConsents: false,
  betaNotices: false,
  multiUserAdmin: false,
  userManagement: false,
  socialLogin: false,
};

interface FeaturesContextType {
  deploymentMode: DeploymentMode | null;
  features: FeatureFlags;
  /**
   * MCP endpoint URL resolved by the server at runtime from its host config,
   * e.g. "http://localhost:8077/mcp". `null` until loaded / on error. Consumers
   * that show the MCP URL use this (in self-host) so it matches the actual
   * host/port instead of a build-time-baked value.
   */
  mcpUrl: string | null;
  loaded: boolean;
  error: boolean;
  retry: () => void;
  isEnabled: (feature: FeatureFlag) => boolean;
}

const FeaturesContext = createContext<FeaturesContextType | undefined>(undefined);

export function FeaturesProvider({ children }: { children: React.ReactNode }) {
  const [deploymentMode, setDeploymentMode] = useState<DeploymentMode | null>(null);
  const [features, setFeatures] = useState<FeatureFlags>(ALL_OFF);
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(false);
    apiClient
      .getFeatures()
      .then((res: FeaturesResponse) => {
        if (cancelled) return;
        setDeploymentMode(res.deploymentMode);
        setFeatures({ ...ALL_OFF, ...res.features });
        setMcpUrl(res.mcpUrl ?? null);
        setError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDeploymentMode(null);
        setFeatures(ALL_OFF);
        setMcpUrl(null);
        setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  const isEnabled = (feature: FeatureFlag) => features[feature] ?? false;

  return (
    <FeaturesContext.Provider
      value={{
        deploymentMode,
        features,
        mcpUrl,
        loaded,
        error,
        retry: () => setRetryKey((current) => current + 1),
        isEnabled,
      }}
    >
      {children}
    </FeaturesContext.Provider>
  );
}

export function useFeatures(): FeaturesContextType {
  const context = useContext(FeaturesContext);
  if (!context) {
    throw new Error("useFeatures must be used within FeaturesProvider");
  }
  return context;
}
