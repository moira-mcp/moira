/**
 * Unit tests for encryption service
 */

import { describe, it, expect, beforeAll } from "@jest/globals";
import {
  encryptValue,
  decryptValue,
  maskEncryptedValue,
  generateEncryptionKey,
} from "@mcp-moira/shared/settings-encryption";

describe("Encryption Service", () => {
  beforeAll(() => {
    // Set test encryption key (32 bytes = 64 hex chars)
    process.env.TELEGRAM_ENCRYPTION_KEY = generateEncryptionKey();
  });

  describe("encryptValue / decryptValue", () => {
    it("decrypts persisted settings ciphertext with a 16-byte IV", () => {
      const originalKey = process.env.TELEGRAM_ENCRYPTION_KEY;
      // Synthetic fixture from the original 16-byte-IV AES-256-GCM settings format.
      // Keep the persisted bytes fixed: generating them here would also accept a changed codec.
      process.env.TELEGRAM_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
      const stored =
        "00112233445566778899aabbccddeeff:19b659e197717e975efdcaff15768413:306dd7346e992053dfeeff160185f8d8f25d0b654c59c964561528c3bb38564d17";
      try {
        expect(decryptValue(stored)).toBe("stored-settings-before-owner-move");
      } finally {
        if (originalKey === undefined) delete process.env.TELEGRAM_ENCRYPTION_KEY;
        else process.env.TELEGRAM_ENCRYPTION_KEY = originalKey;
      }
    });

    it("encrypts and decrypts string correctly", () => {
      const plaintext = "test-bot-token-123456789";
      const encrypted = encryptValue(plaintext);
      const decrypted = decryptValue(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext (random IV)", () => {
      const plaintext = "same-value";
      const encrypted1 = encryptValue(plaintext);
      const encrypted2 = encryptValue(plaintext);

      expect(encrypted1).not.toBe(encrypted2); // Different IV each time
      expect(decryptValue(encrypted1)).toBe(plaintext);
      expect(decryptValue(encrypted2)).toBe(plaintext);
    });

    it("handles special characters", () => {
      const plaintext = "!@#$%^&*()_+-=[]{}|;:,.<>?/~`";
      const encrypted = encryptValue(plaintext);
      const decrypted = decryptValue(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("handles long strings", () => {
      const plaintext = "a".repeat(1000);
      const encrypted = encryptValue(plaintext);
      const decrypted = decryptValue(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("handles unicode characters", () => {
      const plaintext = "测试🔒密钥Тест";
      const encrypted = encryptValue(plaintext);
      const decrypted = decryptValue(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("throws error on invalid encrypted format", () => {
      expect(() => decryptValue("invalid-format")).toThrow("Invalid encrypted data format");
      expect(() => decryptValue("only:two")).toThrow("Invalid encrypted data format");
    });

    it("throws error on tampered data", () => {
      const plaintext = "original";
      const encrypted = encryptValue(plaintext);

      // Tamper with authTag by inverting all bits (guaranteed to be different)
      const parts = encrypted.split(":");
      const invertedAuthTag = parts[1]
        .split("")
        .map((c) => (15 - parseInt(c, 16)).toString(16))
        .join("");
      parts[1] = invertedAuthTag;
      const tampered = parts.join(":");

      expect(() => decryptValue(tampered)).toThrow();
    });
  });

  describe("maskEncryptedValue", () => {
    it("masks value showing last 4 chars", () => {
      const plaintext = "1234567890abcdef";
      const encrypted = encryptValue(plaintext);
      const masked = maskEncryptedValue(encrypted);

      expect(masked).toBe("●●●●●●●●●●●●cdef");
    });

    it("masks short values completely", () => {
      const plaintext = "abc";
      const encrypted = encryptValue(plaintext);
      const masked = maskEncryptedValue(encrypted);

      expect(masked).toBe("●●●");
    });

    it("handles invalid encrypted data gracefully", () => {
      const masked = maskEncryptedValue("invalid-data");
      expect(masked).toBe("●●●●●●●●");
    });
  });

  describe("generateEncryptionKey", () => {
    it("generates 64 hex characters", () => {
      const key = generateEncryptionKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates different keys each time", () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      expect(key1).not.toBe(key2);
    });
  });

  describe("encryption key validation", () => {
    it("throws error if TELEGRAM_ENCRYPTION_KEY not set", () => {
      const original = process.env.TELEGRAM_ENCRYPTION_KEY;
      delete process.env.TELEGRAM_ENCRYPTION_KEY;

      expect(() => encryptValue("test")).toThrow(
        "TELEGRAM_ENCRYPTION_KEY environment variable not set",
      );

      process.env.TELEGRAM_ENCRYPTION_KEY = original;
    });

    it("throws error if key wrong length", () => {
      const original = process.env.TELEGRAM_ENCRYPTION_KEY;
      process.env.TELEGRAM_ENCRYPTION_KEY = "too-short";

      expect(() => encryptValue("test")).toThrow(
        "TELEGRAM_ENCRYPTION_KEY must be 64 hex characters",
      );

      process.env.TELEGRAM_ENCRYPTION_KEY = original;
    });
  });
});
