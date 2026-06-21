/**
 * Execution-lock PIN hashing.
 *
 * The lock PIN is a 6-digit numeric code (low entropy, ~10^6 values), so it is
 * hashed with a salted, deliberately-slow KDF (scrypt) rather than a plain fast
 * hash — a leaked DB row must not be trivially reversible to the PIN by brute
 * force. Plaintext PINs are never stored.
 *
 * Stored format: `scrypt$<saltHex>$<hashHex>`. Verification is constant-time.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const ALGO = "scrypt";
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Hash a PIN for storage. Returns `scrypt$<saltHex>$<hashHex>`. */
export function hashPin(pin: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(pin, salt, KEY_BYTES);
  return `${ALGO}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a PIN against a stored hash (constant-time).
 *
 * Returns false for any malformed/legacy value rather than throwing, so a
 * pre-hash plaintext row simply fails verification (and must be re-locked) —
 * v0.x has no migration of in-flight locks.
 */
export function verifyPin(pin: string, stored: string): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== ALGO) return false;

  const [, saltHex, hashHex] = parts;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false;

  const derived = scryptSync(pin, salt, KEY_BYTES);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Whether a stored value is in the hashed format (vs legacy plaintext). */
export function isHashedPin(stored: string): boolean {
  return typeof stored === "string" && stored.startsWith(`${ALGO}$`);
}
