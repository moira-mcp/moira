/**
 * Input sanitization and truncation for error logging
 *
 * Provides automatic sanitization of sensitive data and truncation
 * for safe inclusion in error logs.
 */

import type { ResourceIds } from "./context.js";

/** Maximum total size for inputData in bytes */
const MAX_TOTAL_SIZE = 10 * 1024; // 10KB

/** Maximum size for individual string values */
const MAX_STRING_SIZE = 1024; // 1KB

/** Maximum nesting depth to preserve */
const MAX_DEPTH = 3;

/**
 * Sensitive field name patterns (case-insensitive)
 * Fields containing any of these will be removed
 */
const SENSITIVE_PATTERNS = [
  "password",
  "token",
  "secret",
  "key",
  "auth",
  "credential",
  "private",
  "session",
  "bearer",
  "refresh",
  "access",
  "pin",
  "otp",
  "cvv",
  "passphrase",
];

/**
 * Check if a field name is sensitive
 */
function isSensitiveField(fieldName: string): boolean {
  const lowerName = fieldName.toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => lowerName.includes(pattern));
}

/**
 * Mask email address: user@domain.com → us***@domain.com
 */
function maskEmail(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return email;

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex);

  if (localPart.length <= 2) {
    return `${localPart[0]}***${domain}`;
  }

  return `${localPart.slice(0, 2)}***${domain}`;
}

/**
 * Check if a string looks like an email
 */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Truncate a string if it exceeds max size
 */
function truncateString(value: string, maxSize: number = MAX_STRING_SIZE): string {
  if (value.length <= maxSize) {
    return value;
  }
  return value.slice(0, maxSize) + "[truncated]";
}

/**
 * Calculate approximate JSON size of a value
 */
function approximateSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/**
 * Sanitize and truncate input data recursively
 *
 * @param input - The input data to sanitize
 * @param depth - Current recursion depth
 * @param currentSize - Running total of output size
 * @returns Sanitized and truncated data with _truncated flag if truncated
 */
function sanitizeRecursive(
  input: unknown,
  depth: number = 0,
  currentSize: { value: number } = { value: 0 },
): unknown {
  // Check total size limit
  if (currentSize.value >= MAX_TOTAL_SIZE) {
    return "[size limit exceeded]";
  }

  // Handle null/undefined
  if (input === null || input === undefined) {
    return input;
  }

  // Handle primitives
  if (typeof input === "boolean" || typeof input === "number") {
    currentSize.value += String(input).length;
    return input;
  }

  // Handle strings
  if (typeof input === "string") {
    // Mask emails
    if (isEmail(input)) {
      const masked = maskEmail(input);
      currentSize.value += masked.length;
      return masked;
    }

    // Truncate long strings
    const truncated = truncateString(input);
    currentSize.value += truncated.length;
    return truncated;
  }

  // Handle arrays
  if (Array.isArray(input)) {
    if (depth >= MAX_DEPTH) {
      return "[nested array]";
    }

    const result: unknown[] = [];
    let wasTruncated = false;

    for (const item of input) {
      // Check if adding this item would exceed limit
      const itemSize = approximateSize(item);
      if (currentSize.value + itemSize > MAX_TOTAL_SIZE) {
        wasTruncated = true;
        break;
      }

      result.push(sanitizeRecursive(item, depth + 1, currentSize));
    }

    if (wasTruncated && result.length > 0) {
      // Add truncation indicator as metadata
      return { _items: result, _truncated: true, _originalLength: input.length };
    }

    return result;
  }

  // Handle objects
  if (typeof input === "object") {
    if (depth >= MAX_DEPTH) {
      return "[nested object]";
    }

    const result: Record<string, unknown> = {};
    let wasTruncated = false;

    for (const [key, value] of Object.entries(input)) {
      // Skip sensitive fields
      if (isSensitiveField(key)) {
        continue;
      }

      // Check if adding this field would exceed limit
      const fieldSize = approximateSize({ [key]: value });
      if (currentSize.value + fieldSize > MAX_TOTAL_SIZE) {
        wasTruncated = true;
        break;
      }

      result[key] = sanitizeRecursive(value, depth + 1, currentSize);
    }

    if (wasTruncated) {
      result._truncated = true;
    }

    return result;
  }

  // Fallback for unknown types
  return "[unknown type]";
}

/**
 * Extract resource IDs from input (fields matching *Id pattern)
 *
 * @param input - The input data
 * @returns Extracted resource IDs
 */
export function extractResourceIds(input: unknown): ResourceIds {
  const resourceIds: ResourceIds = {};

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return resourceIds;
  }

  for (const [key, value] of Object.entries(input)) {
    // Match fields ending with "Id" (case-sensitive to avoid false positives)
    if (key.endsWith("Id") && typeof value === "string") {
      resourceIds[key] = value;
    }
  }

  return resourceIds;
}

/**
 * Remove resource ID fields from input (they're logged separately)
 *
 * @param input - The input data
 * @returns Input without resource ID fields
 */
function removeResourceIds(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    // Skip fields ending with "Id"
    if (!key.endsWith("Id")) {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Sanitize input data for safe logging
 *
 * - Removes sensitive fields (password, token, secret, key, auth, etc.)
 * - Masks email addresses
 * - Truncates long strings (>1KB)
 * - Limits total size to 10KB
 * - Limits nesting depth to 3 levels
 * - Adds _truncated flag when data is truncated
 *
 * @param input - The raw input data
 * @returns Object with sanitized inputData and extracted resourceIds
 */
export function sanitizeInput(input: unknown): {
  inputData: unknown;
  resourceIds: ResourceIds;
} {
  // Extract resource IDs first (they're logged separately)
  const resourceIds = extractResourceIds(input);

  // Remove resource IDs from input (to avoid duplication)
  const inputWithoutIds = removeResourceIds(input);

  // Sanitize and truncate the remaining data
  const inputData = sanitizeRecursive(inputWithoutIds);

  return { inputData, resourceIds };
}

/**
 * Check if input data was truncated
 */
export function wasTruncated(sanitized: unknown): boolean {
  if (!sanitized || typeof sanitized !== "object") {
    return false;
  }

  if ("_truncated" in sanitized) {
    return true;
  }

  return false;
}
