/**
 * Persistent API Token utilities
 *
 * Token format: moira_ + 40 hex chars = 46 chars total (160 bits entropy)
 * Storage: SHA-256 hash only, plaintext never stored
 * Prefix: first 12 chars (moira_ + 6 hex) for visual identification
 */

import { randomBytes, createHash } from "crypto";

export const TOKEN_PREFIX = "moira_";
export const TOKEN_HEX_LENGTH = 40;
export const TOKEN_TOTAL_LENGTH = TOKEN_PREFIX.length + TOKEN_HEX_LENGTH; // 46
export const TOKEN_DISPLAY_PREFIX_LENGTH = 12; // "moira_" + 6 hex chars
export const MAX_TOKENS_PER_USER = 25;

export const EXPIRATION_OPTIONS = {
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  "365d": 365 * 24 * 60 * 60 * 1000,
  never: null,
} as const;

export type ExpirationOption = keyof typeof EXPIRATION_OPTIONS;
export const DEFAULT_EXPIRATION: ExpirationOption = "90d";

/**
 * Generate a new persistent API token.
 * Returns the full plaintext token (shown once to user, never stored).
 */
export function generateToken(): string {
  const hex = randomBytes(TOKEN_HEX_LENGTH / 2).toString("hex");
  return `${TOKEN_PREFIX}${hex}`;
}

/**
 * Hash a token using SHA-256.
 * Only the hash is stored in the database.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Extract the display prefix from a token (first 12 chars).
 * Used for visual identification in UI lists.
 */
export function extractTokenPrefix(token: string): string {
  return token.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH);
}

/**
 * Check if a string looks like a persistent API token.
 */
export function isPersistentToken(token: string): boolean {
  return (
    token.startsWith(TOKEN_PREFIX) &&
    token.length === TOKEN_TOTAL_LENGTH &&
    /^[0-9a-f]+$/.test(token.slice(TOKEN_PREFIX.length))
  );
}

/**
 * Validate a token record against expiration and revocation.
 * Returns null if valid, or an error reason string.
 */
export function validateTokenRecord(record: {
  expiresAt: string | null;
  revokedAt: string | null;
}): string | null {
  if (record.revokedAt) {
    return "token_revoked";
  }
  if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
    return "token_expired";
  }
  return null;
}

/**
 * Generate a new token ID (UUID v4-like).
 */
export function generateTokenId(): string {
  return crypto.randomUUID();
}

/**
 * Calculate expiration date from an expiration option.
 * Returns ISO string or null for "never".
 */
export function calculateExpiration(option: ExpirationOption): string | null {
  const ms = EXPIRATION_OPTIONS[option];
  if (ms === null) return null;
  return new Date(Date.now() + ms).toISOString();
}
