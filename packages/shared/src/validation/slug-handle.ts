/**
 * Slug and Handle Validation Utilities
 *
 * Slug: workflow identifier, unique per user (4-80 chars, alphanumeric + hyphen)
 * Handle: user identifier, globally unique (4-40 chars, alphanumeric + hyphen)
 *
 * Global workflow reference: handle/slug (e.g., john-doe/my-workflow)
 */

// ===== Constants =====

export const SLUG_MIN_LENGTH = 4;
export const SLUG_MAX_LENGTH = 80;
export const HANDLE_MIN_LENGTH = 4;
export const HANDLE_MAX_LENGTH = 40;

function isLowerAlphanumeric(character: string): boolean {
  return (character >= "a" && character <= "z") || (character >= "0" && character <= "9");
}

function hasValidSlugCharacters(value: string): boolean {
  if (!value || !isLowerAlphanumeric(value[0]) || !isLowerAlphanumeric(value[value.length - 1])) {
    return false;
  }
  for (const character of value) {
    if (character !== "-" && !isLowerAlphanumeric(character)) return false;
  }
  return true;
}

// ===== Validation Functions =====

/**
 * Validate slug format
 * @param slug - The slug to validate
 * @returns Object with valid flag and optional error message
 */
export function validateSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || typeof slug !== "string") {
    return { valid: false, error: "Slug is required" };
  }

  const normalized = slug.toLowerCase().trim();

  if (normalized.length < SLUG_MIN_LENGTH) {
    return {
      valid: false,
      error: `Slug must be at least ${SLUG_MIN_LENGTH} characters`,
    };
  }

  if (normalized.length > SLUG_MAX_LENGTH) {
    return {
      valid: false,
      error: `Slug must be at most ${SLUG_MAX_LENGTH} characters`,
    };
  }

  if (!hasValidSlugCharacters(normalized)) {
    return {
      valid: false,
      error:
        "Slug must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
    };
  }

  // Check for consecutive hyphens
  if (normalized.includes("--")) {
    return {
      valid: false,
      error: "Slug cannot contain consecutive hyphens",
    };
  }

  return { valid: true };
}

/**
 * Validate handle format
 * @param handle - The handle to validate
 * @returns Object with valid flag and optional error message
 */
export function validateHandle(handle: string): { valid: boolean; error?: string } {
  if (!handle || typeof handle !== "string") {
    return { valid: false, error: "Handle is required" };
  }

  const normalized = handle.toLowerCase().trim();

  if (normalized.length < HANDLE_MIN_LENGTH) {
    return {
      valid: false,
      error: `Handle must be at least ${HANDLE_MIN_LENGTH} characters`,
    };
  }

  if (normalized.length > HANDLE_MAX_LENGTH) {
    return {
      valid: false,
      error: `Handle must be at most ${HANDLE_MAX_LENGTH} characters`,
    };
  }

  if (!hasValidSlugCharacters(normalized)) {
    return {
      valid: false,
      error:
        "Handle must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
    };
  }

  // Check for consecutive hyphens
  if (normalized.includes("--")) {
    return {
      valid: false,
      error: "Handle cannot contain consecutive hyphens",
    };
  }

  return { valid: true };
}

// ===== Normalization Functions =====

/**
 * Normalize a slug (lowercase, trim)
 * @param slug - The slug to normalize
 * @returns Normalized slug
 */
export function normalizeSlug(slug: string): string {
  return slug.toLowerCase().trim();
}

/**
 * Normalize a handle (lowercase, trim)
 * @param handle - The handle to normalize
 * @returns Normalized handle
 */
export function normalizeHandle(handle: string): string {
  return handle.toLowerCase().trim();
}

// ===== Generation Functions =====

/**
 * Generate a valid base handle from an email address. The caller remains
 * responsible for checking global uniqueness and adding a collision suffix.
 */
export function generateHandleFromEmail(email: string): string {
  const prefix = email.split("@")[0] || "";
  let handle = prefix.toLowerCase().replace(/[^a-z0-9]/g, "-");
  handle = handle.replace(/-+/g, "-").replace(/^-+|-+$/g, "");

  while (handle.length < HANDLE_MIN_LENGTH) {
    handle += Math.random().toString(36).charAt(2);
  }

  return handle.substring(0, HANDLE_MAX_LENGTH - 5);
}

/** Generate a short suffix for resolving a globally unique handle collision. */
export function generateRandomHandleSuffix(): string {
  return Math.random().toString(36).substring(2, 6);
}

/**
 * Generate a random slug suffix
 * @returns 8-character random alphanumeric string
 */
export function generateRandomSlugSuffix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a default slug for a new workflow
 * Pattern: workflow-{random8}
 * @returns Generated slug
 */
export function generateDefaultSlug(): string {
  return `workflow-${generateRandomSlugSuffix()}`;
}

/**
 * Generate a slug from a workflow name
 * @param name - Workflow name to convert
 * @returns Generated slug
 */
export function generateSlugFromName(name: string): string {
  let slug = "";
  let separatorPending = false;
  for (const character of name.toLowerCase()) {
    if (isLowerAlphanumeric(character)) {
      if (separatorPending && slug.length > 0) slug += "-";
      slug += character;
      separatorPending = false;
    } else {
      separatorPending = slug.length > 0;
    }
  }

  // Ensure minimum length
  if (slug.length < SLUG_MIN_LENGTH) {
    slug = `${slug}-${generateRandomSlugSuffix()}`.substring(0, SLUG_MAX_LENGTH);
  }

  // Truncate to max length (leaving room for collision suffix)
  if (slug.length > SLUG_MAX_LENGTH - 5) {
    slug = slug.substring(0, SLUG_MAX_LENGTH - 5);
    while (slug.endsWith("-")) slug = slug.slice(0, -1);
  }

  // Final validation - if still invalid, generate random
  const validation = validateSlug(slug);
  if (!validation.valid) {
    return generateDefaultSlug();
  }

  return slug;
}

// ===== Parsing Functions =====

/**
 * Parse a global workflow reference (handle/slug)
 * @param reference - The reference to parse (e.g., "john-doe/my-workflow")
 * @returns Parsed handle and slug, or null if invalid
 */
export function parseWorkflowReference(reference: string): { handle: string; slug: string } | null {
  if (!reference || typeof reference !== "string") {
    return null;
  }

  const parts = reference.split("/");
  if (parts.length !== 2) {
    return null;
  }

  const [handle, slug] = parts;

  if (!handle || !slug) {
    return null;
  }

  const handleValidation = validateHandle(handle);
  const slugValidation = validateSlug(slug);

  if (!handleValidation.valid || !slugValidation.valid) {
    return null;
  }

  return {
    handle: normalizeHandle(handle),
    slug: normalizeSlug(slug),
  };
}

/**
 * Create a global workflow reference from handle and slug
 * @param handle - User handle
 * @param slug - Workflow slug
 * @returns Global reference string (handle/slug)
 */
export function createWorkflowReference(handle: string, slug: string): string {
  return `${normalizeHandle(handle)}/${normalizeSlug(slug)}`;
}
