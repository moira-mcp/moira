/**
 * Encryption Service for Sensitive Settings
 * AES-256-GCM encryption with random IV per value
 */

import crypto from "crypto";
import { getTelegramEncryptionKey } from "@mcp-moira/shared";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const _AUTH_TAG_LENGTH = 16;

/**
 * Get encryption key from environment
 * Key must be 32 bytes (64 hex chars) for AES-256
 */
function getEncryptionKey(): Buffer {
  const keyHex = getTelegramEncryptionKey();

  if (!keyHex) {
    throw new Error("TELEGRAM_ENCRYPTION_KEY environment variable not set");
  }

  if (keyHex.length !== 64) {
    throw new Error("TELEGRAM_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }

  return Buffer.from(keyHex, "hex");
}

/**
 * Encrypt plaintext value
 * Returns format: iv:authTag:encrypted (all hex)
 */
export function encryptValue(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypt encrypted value
 * Expects format: iv:authTag:encrypted
 */
export function decryptValue(encryptedData: string): string {
  const key = getEncryptionKey();

  const parts = encryptedData.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format (expected iv:authTag:encrypted)");
  }

  const [ivHex, authTagHex, encrypted] = parts;

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    throw new Error("Decryption failed - data may be tampered or corrupted");
  }
}

/**
 * Mask encrypted value for display (shows only last 4 chars)
 */
export function maskEncryptedValue(encryptedData: string): string {
  try {
    const decrypted = decryptValue(encryptedData);
    if (decrypted.length <= 4) {
      return "●".repeat(decrypted.length);
    }
    return "●".repeat(decrypted.length - 4) + decrypted.slice(-4);
  } catch (error) {
    return "●●●●●●●●";
  }
}

/**
 * Generate encryption key (for setup/documentation)
 * Returns 64 hex characters (32 bytes)
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString("hex");
}
