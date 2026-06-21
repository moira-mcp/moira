/**
 * Version Utilities
 * Semver validation, comparison, and workflow content comparison
 */

/**
 * Validate semver format (X.Y.Z where X, Y, Z are non-negative integers)
 */
export function isValidSemver(version: unknown): boolean {
  if (typeof version !== "string" || !version) {
    return false;
  }

  const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  return semverRegex.test(version);
}

/**
 * Parse semver string into components
 * Returns null if invalid
 */
export function parseSemver(
  version: string,
): { major: number; minor: number; patch: number } | null {
  if (!isValidSemver(version)) {
    return null;
  }

  const parts = version.split(".").map(Number);
  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
  };
}

/**
 * Compare two semver versions
 * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 * Throws if either version is invalid
 */
export function compareSemver(v1: string, v2: string): -1 | 0 | 1 {
  const parsed1 = parseSemver(v1);
  const parsed2 = parseSemver(v2);

  if (!parsed1) {
    throw new Error(`Invalid semver version: ${v1}`);
  }
  if (!parsed2) {
    throw new Error(`Invalid semver version: ${v2}`);
  }

  // Compare major
  if (parsed1.major > parsed2.major) return 1;
  if (parsed1.major < parsed2.major) return -1;

  // Compare minor
  if (parsed1.minor > parsed2.minor) return 1;
  if (parsed1.minor < parsed2.minor) return -1;

  // Compare patch
  if (parsed1.patch > parsed2.patch) return 1;
  if (parsed1.patch < parsed2.patch) return -1;

  return 0;
}

/**
 * Check if newVersion is greater than oldVersion
 */
export function isVersionIncremented(oldVersion: string, newVersion: string): boolean {
  return compareSemver(newVersion, oldVersion) === 1;
}

/**
 * Increment patch version (X.Y.Z -> X.Y.Z+1)
 * Returns new version string
 * Throws if version is invalid
 */
export function incrementPatchVersion(version: string): string {
  const parsed = parseSemver(version);
  if (!parsed) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

/**
 * Normalize workflow object for content comparison
 * Removes version field and timestamps, sorts keys for consistent comparison
 */
export function normalizeWorkflowForComparison(workflow: unknown): string {
  if (workflow === null) {
    return "null";
  }
  if (workflow === undefined) {
    return "undefined";
  }

  const normalize = (obj: unknown): unknown => {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(normalize);
    }

    if (typeof obj === "object") {
      const record = obj as Record<string, unknown>;
      const sortedKeys = Object.keys(record).sort();
      const normalized: Record<string, unknown> = {};

      for (const key of sortedKeys) {
        // Skip version field in metadata
        if (key === "version") {
          continue;
        }
        // Skip id field (local files use slug as id, server uses UUID)
        if (key === "id") {
          continue;
        }
        // Skip timestamp fields
        if (key === "createdAt" || key === "updatedAt") {
          continue;
        }
        normalized[key] = normalize(record[key]);
      }

      return normalized;
    }

    return obj;
  };

  return JSON.stringify(normalize(workflow));
}

/**
 * Compare two workflow objects for content changes
 * Ignores version field and timestamps
 * Returns true if content has changed
 */
export function hasWorkflowContentChanged(original: unknown, modified: unknown): boolean {
  const normalizedOriginal = normalizeWorkflowForComparison(original);
  const normalizedModified = normalizeWorkflowForComparison(modified);

  return normalizedOriginal !== normalizedModified;
}

/**
 * Version validation result
 */
export interface VersionValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate workflow version change
 * Returns error if content changed but version not incremented
 */
export function validateVersionChange(
  originalWorkflow: { metadata?: { version?: string } },
  modifiedWorkflow: { metadata?: { version?: string } },
): VersionValidationResult {
  const oldVersion = originalWorkflow?.metadata?.version;
  const newVersion = modifiedWorkflow?.metadata?.version;

  // Validate new version is valid semver
  if (!newVersion) {
    return { valid: false, error: "Version is required in workflow metadata" };
  }

  if (!isValidSemver(newVersion)) {
    return {
      valid: false,
      error: `Invalid semver version: "${newVersion}". Must be in X.Y.Z format (e.g., 1.0.0)`,
    };
  }

  // If no original version, any valid version is ok (new workflow)
  if (!oldVersion) {
    return { valid: true };
  }

  // Check if content changed
  const contentChanged = hasWorkflowContentChanged(originalWorkflow, modifiedWorkflow);

  if (!contentChanged) {
    // No content changes, version can stay the same or increase
    return { valid: true };
  }

  // Content changed - version must be incremented
  if (!isVersionIncremented(oldVersion, newVersion)) {
    return {
      valid: false,
      error: `Content changed but version not incremented. Current: ${oldVersion}, new: ${newVersion}. Bump the version or use --force to bypass.`,
    };
  }

  return { valid: true };
}
