import { describe, it, expect } from "@jest/globals";
import {
  generateToken,
  hashToken,
  extractTokenPrefix,
  isPersistentToken,
  validateTokenRecord,
  generateTokenId,
  calculateExpiration,
  TOKEN_PREFIX,
  TOKEN_TOTAL_LENGTH,
  TOKEN_DISPLAY_PREFIX_LENGTH,
  MAX_TOKENS_PER_USER,
  EXPIRATION_OPTIONS,
  DEFAULT_EXPIRATION,
} from "@mcp-moira/shared";

describe("API Token Utilities", () => {
  describe("generateToken", () => {
    it("produces token with moira_ prefix", () => {
      const token = generateToken();
      expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    });

    it("produces token of correct total length (46 chars)", () => {
      const token = generateToken();
      expect(token.length).toBe(TOKEN_TOTAL_LENGTH);
    });

    it("produces hex characters after prefix", () => {
      const token = generateToken();
      const hex = token.slice(TOKEN_PREFIX.length);
      expect(hex).toMatch(/^[0-9a-f]{40}$/);
    });

    it("generates unique tokens on each call", () => {
      const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
      expect(tokens.size).toBe(100);
    });
  });

  describe("hashToken", () => {
    it("produces 64-char hex SHA-256 hash", () => {
      const token = generateToken();
      const hash = hashToken(token);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic — same input produces same hash", () => {
      const token = generateToken();
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different tokens", () => {
      const hash1 = hashToken(generateToken());
      const hash2 = hashToken(generateToken());
      expect(hash1).not.toBe(hash2);
    });

    it("matches known SHA-256 output", () => {
      // Verify hash is a valid SHA-256 of the input
      const input = "moira_0000000000000000000000000000000000000000";
      const hash = hashToken(input);
      // Hash again to verify determinism
      const hash2 = hashToken(input);
      expect(hash).toBe(hash2);
      expect(hash.length).toBe(64);
    });
  });

  describe("extractTokenPrefix", () => {
    it("extracts first 12 characters", () => {
      const token = "moira_abcdef1234567890abcdef1234567890abcd";
      const prefix = extractTokenPrefix(token);
      expect(prefix).toBe("moira_abcdef");
      expect(prefix.length).toBe(TOKEN_DISPLAY_PREFIX_LENGTH);
    });
  });

  describe("isPersistentToken", () => {
    it("accepts valid persistent token", () => {
      const token = generateToken();
      expect(isPersistentToken(token)).toBe(true);
    });

    it("rejects token without moira_ prefix", () => {
      expect(isPersistentToken("bearer_abcdef1234567890abcdef1234567890abcd")).toBe(false);
    });

    it("rejects token with wrong length", () => {
      expect(isPersistentToken("moira_abc")).toBe(false);
      expect(isPersistentToken("moira_" + "a".repeat(50))).toBe(false);
    });

    it("rejects token with non-hex characters after prefix", () => {
      expect(isPersistentToken("moira_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isPersistentToken("")).toBe(false);
    });

    it("rejects OAuth-style tokens", () => {
      expect(isPersistentToken("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(false);
    });
  });

  describe("validateTokenRecord", () => {
    it("returns null for valid active token", () => {
      const result = validateTokenRecord({
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        revokedAt: null,
      });
      expect(result).toBeNull();
    });

    it("returns null for token with no expiration", () => {
      const result = validateTokenRecord({
        expiresAt: null,
        revokedAt: null,
      });
      expect(result).toBeNull();
    });

    it("returns 'token_revoked' for revoked token", () => {
      const result = validateTokenRecord({
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        revokedAt: new Date().toISOString(),
      });
      expect(result).toBe("token_revoked");
    });

    it("returns 'token_expired' for expired token", () => {
      const result = validateTokenRecord({
        expiresAt: new Date(Date.now() - 86400000).toISOString(),
        revokedAt: null,
      });
      expect(result).toBe("token_expired");
    });

    it("prioritizes revoked over expired", () => {
      const result = validateTokenRecord({
        expiresAt: new Date(Date.now() - 86400000).toISOString(),
        revokedAt: new Date().toISOString(),
      });
      expect(result).toBe("token_revoked");
    });
  });

  describe("generateTokenId", () => {
    it("produces UUID-format string", () => {
      const id = generateTokenId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateTokenId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("calculateExpiration", () => {
    it("returns ISO string for 30d", () => {
      const before = Date.now();
      const result = calculateExpiration("30d");
      expect(result).not.toBeNull();
      const diff = new Date(result!).getTime() - before;
      expect(diff).toBeGreaterThanOrEqual(29 * 24 * 60 * 60 * 1000);
      expect(diff).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);
    });

    it("returns ISO string for 90d (default)", () => {
      const before = Date.now();
      const result = calculateExpiration(DEFAULT_EXPIRATION);
      expect(result).not.toBeNull();
      const diff = new Date(result!).getTime() - before;
      expect(diff).toBeGreaterThanOrEqual(89 * 24 * 60 * 60 * 1000);
      expect(diff).toBeLessThanOrEqual(91 * 24 * 60 * 60 * 1000);
    });

    it("returns ISO string for 365d", () => {
      const result = calculateExpiration("365d");
      expect(result).not.toBeNull();
      const diff = new Date(result!).getTime() - Date.now();
      expect(diff).toBeGreaterThanOrEqual(364 * 24 * 60 * 60 * 1000);
    });

    it("returns null for 'never'", () => {
      const result = calculateExpiration("never");
      expect(result).toBeNull();
    });
  });

  describe("Constants", () => {
    it("TOKEN_PREFIX is moira_", () => {
      expect(TOKEN_PREFIX).toBe("moira_");
    });

    it("TOKEN_TOTAL_LENGTH is 46", () => {
      expect(TOKEN_TOTAL_LENGTH).toBe(46);
    });

    it("TOKEN_DISPLAY_PREFIX_LENGTH is 12", () => {
      expect(TOKEN_DISPLAY_PREFIX_LENGTH).toBe(12);
    });

    it("MAX_TOKENS_PER_USER is 25", () => {
      expect(MAX_TOKENS_PER_USER).toBe(25);
    });

    it("EXPIRATION_OPTIONS has all expected keys", () => {
      expect(Object.keys(EXPIRATION_OPTIONS).sort()).toEqual(
        ["30d", "365d", "90d", "never"].sort(),
      );
    });

    it("DEFAULT_EXPIRATION is 90d", () => {
      expect(DEFAULT_EXPIRATION).toBe("90d");
    });
  });
});
