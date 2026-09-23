/**
 * What a codespace request failure says to the reader, in the reader's language.
 *
 * The server answers every codespace failure with a stable `code` and an English sentence meant for
 * logs and agents. The interface reads the code: a known one has its own localized message, and
 * anything else — an unknown code, a network failure — says the caller's localized generic message
 * rather than English server prose.
 */

import type { TFunction } from "i18next";

/** Every code a codespace route can answer with, each with a message under `common.codespaceErrors`. */
export const CODESPACE_ERROR_CODES = [
  // Resource and operation refusals (CodespaceResourceErrorCode).
  "CODESPACE_PROVIDER_DISABLED",
  "CODESPACE_PROVIDER_UNAVAILABLE",
  "CODESPACE_POLICY_LIMIT",
  "CODESPACE_SESSION_UNAVAILABLE",
  "CODESPACE_OPERATION_BUSY",
  "CODESPACE_AUTHORIZATION_REQUIRED",
  "CODESPACE_RESULT_EXPIRED",
  "CODESPACE_CREATE_REJECTED",
  "CODESPACE_CREATE_PENDING",
  "CODESPACE_NOT_RUNNING",
  "CODESPACE_START_TIMEOUT",
  "CODESPACE_GENERATION_CONFLICT",
  "CODESPACE_RESOURCE_INVALID",
  "CODESPACE_NOT_FOUND",
  // Route-level refusals.
  "CODESPACE_NOT_CONFIGURED",
  "CODESPACE_DELETE_CONFIRMATION_REQUIRED",
  "CODESPACE_CONTROL_INVALID",
  // GitHub connection refusals (CodespaceConnectionErrorCode).
  "CONNECTION_REQUIRED",
  "INSTALLATION_REQUIRED",
  "REPOSITORY_NOT_ALLOWED",
  "AUTH_REFRESH_FAILED",
  "AUTH_GRANT_REVOCATION_REQUIRED",
  "CREDENTIAL_UNREADABLE",
  "AUTHORIZATION_FAILED",
] as const;

const KNOWN: ReadonlySet<string> = new Set(CODESPACE_ERROR_CODES);

export function codespaceErrorMessage(error: unknown, t: TFunction, fallbackKey: string): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && KNOWN.has(code)
    ? t(`common.codespaceErrors.${code}`)
    : t(fallbackKey);
}
