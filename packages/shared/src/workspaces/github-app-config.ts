import {
  getAppPrefix,
  getWorkspaceCredentialVaultKey,
  getWorkspaceCredentialVaultKeyVersion,
  getWorkspaceGitHubAppCallbackUrl,
  getWorkspaceGitHubAppInstallUrl,
  getWorkspaceGitHubAppClientId,
  getWorkspaceGitHubAppClientSecret,
} from "../config/env.js";
import { getBaseUrl } from "../config/urls.js";

export const GITHUB_WORKSPACE_CALLBACK_PATH = "/api/integrations/github/callback";
export const GITHUB_SETTINGS_FRAGMENT = "integrations-github";

export type WorkspaceGitHubConfigReason =
  | "NOT_CONFIGURED"
  | "INCOMPLETE_CONFIGURATION"
  | "INVALID_CLIENT_ID"
  | "INVALID_CLIENT_SECRET"
  | "INVALID_CALLBACK_URL"
  | "INVALID_INSTALL_URL"
  | "CALLBACK_ORIGIN_MISMATCH"
  | "INVALID_VAULT_KEY"
  | "INVALID_KEY_VERSION";

export type WorkspaceGitHubConfigStatus =
  | { state: "disabled"; reason: "NOT_CONFIGURED"; settingsUrl: string }
  | { state: "invalid"; reason: WorkspaceGitHubConfigReason; settingsUrl: string }
  | {
      state: "available";
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
      installationUrl: string;
      vaultKeyHex: string;
      vaultKeyVersion: string;
      settingsUrl: string;
    };

export interface WorkspaceGitHubConfigInput {
  clientId?: string;
  clientSecret?: string;
  callbackUrl?: string;
  installationUrl?: string;
  vaultKeyHex?: string;
  vaultKeyVersion?: string;
  baseUrl: string;
  appPrefix?: string;
}

function normalizeAppPrefix(raw: string | undefined): string {
  if (!raw || raw === "/") return "";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function safeSettingsUrl(baseUrl: string, appPrefix?: string): string {
  return `${baseUrl}${normalizeAppPrefix(appPrefix)}/settings#${GITHUB_SETTINGS_FRAGMENT}`;
}

function isWeakVaultKey(value: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(value)) return true;
  const lower = value.toLowerCase();
  if (/^(.)\1{63}$/.test(lower)) return true;
  if (lower === "0123456789abcdef".repeat(4)) return true;
  return new Set(lower.match(/.{2}/g)).size < 8;
}

function isWeakClientSecret(value: string): boolean {
  if (value.length < 20 || value.length > 256) return true;
  const normalized = value.toLowerCase();
  if (/^(.)\1+$/.test(normalized)) return true;
  if (/^(?:change-?me|example|placeholder|secret|test)[-_a-z0-9]*$/i.test(value)) return true;
  return new Set(normalized).size < 8;
}

export function evaluateWorkspaceGitHubConfig(
  input: WorkspaceGitHubConfigInput,
): WorkspaceGitHubConfigStatus {
  const clientId = input.clientId?.trim();
  const clientSecret = input.clientSecret?.trim();
  const callbackUrl = input.callbackUrl?.trim();
  const installationUrl = input.installationUrl?.trim();
  const vaultKeyHex = input.vaultKeyHex?.trim();
  const vaultKeyVersion = input.vaultKeyVersion?.trim() || "v1";
  const settingsUrl = safeSettingsUrl(input.baseUrl, input.appPrefix);
  const supplied = [clientId, clientSecret, callbackUrl, installationUrl, vaultKeyHex].filter(
    Boolean,
  ).length;

  if (supplied === 0) return { state: "disabled", reason: "NOT_CONFIGURED", settingsUrl };
  if (supplied !== 5) {
    return { state: "invalid", reason: "INCOMPLETE_CONFIGURATION", settingsUrl };
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId!)) {
    return { state: "invalid", reason: "INVALID_CLIENT_ID", settingsUrl };
  }
  if (isWeakClientSecret(clientSecret!)) {
    return { state: "invalid", reason: "INVALID_CLIENT_SECRET", settingsUrl };
  }
  if (isWeakVaultKey(vaultKeyHex!)) {
    return { state: "invalid", reason: "INVALID_VAULT_KEY", settingsUrl };
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(vaultKeyVersion)) {
    return { state: "invalid", reason: "INVALID_KEY_VERSION", settingsUrl };
  }

  let parsedCallback: URL;
  let parsedBase: URL;
  try {
    parsedCallback = new URL(callbackUrl!);
    parsedBase = new URL(input.baseUrl);
  } catch {
    return { state: "invalid", reason: "INVALID_CALLBACK_URL", settingsUrl };
  }
  const local = parsedCallback.hostname === "localhost" || parsedCallback.hostname === "127.0.0.1";
  if (
    parsedCallback.username ||
    parsedCallback.password ||
    parsedCallback.search ||
    parsedCallback.hash ||
    parsedCallback.pathname !== GITHUB_WORKSPACE_CALLBACK_PATH ||
    (!local && parsedCallback.protocol !== "https:")
  ) {
    return { state: "invalid", reason: "INVALID_CALLBACK_URL", settingsUrl };
  }
  if (parsedCallback.origin !== parsedBase.origin) {
    return { state: "invalid", reason: "CALLBACK_ORIGIN_MISMATCH", settingsUrl };
  }
  let parsedInstallation: URL;
  try {
    parsedInstallation = new URL(installationUrl!);
  } catch {
    return { state: "invalid", reason: "INVALID_INSTALL_URL", settingsUrl };
  }
  if (
    parsedInstallation.origin !== "https://github.com" ||
    !/^\/apps\/[A-Za-z0-9-]+\/installations\/new$/.test(parsedInstallation.pathname) ||
    parsedInstallation.search ||
    parsedInstallation.hash
  ) {
    return { state: "invalid", reason: "INVALID_INSTALL_URL", settingsUrl };
  }

  return {
    state: "available",
    clientId: clientId!,
    clientSecret: clientSecret!,
    callbackUrl: parsedCallback.toString(),
    installationUrl: parsedInstallation.toString(),
    vaultKeyHex: vaultKeyHex!.toLowerCase(),
    vaultKeyVersion,
    settingsUrl,
  };
}

export function getWorkspaceGitHubConfig(): WorkspaceGitHubConfigStatus {
  return evaluateWorkspaceGitHubConfig({
    clientId: getWorkspaceGitHubAppClientId(),
    clientSecret: getWorkspaceGitHubAppClientSecret(),
    callbackUrl: getWorkspaceGitHubAppCallbackUrl(),
    installationUrl: getWorkspaceGitHubAppInstallUrl(),
    vaultKeyHex: getWorkspaceCredentialVaultKey(),
    vaultKeyVersion: getWorkspaceCredentialVaultKeyVersion(),
    baseUrl: getBaseUrl(),
    appPrefix: getAppPrefix(),
  });
}
