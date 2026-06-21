/**
 * Path Resolution Utility for Variable Access
 * Unified implementation for dot-notation and array indexing support
 */

import { createLogger } from "@mcp-moira/shared";

export interface PathSegment {
  type: "property" | "index";
  key?: string;
  index?: number;
}

export class PathResolver {
  private static logger = createLogger({ component: "PathResolver" });

  /**
   * Resolve nested variable paths (e.g., "user.profile.name", "items[0].value")
   */
  static resolveVariablePath(context: Record<string, unknown>, path: string): unknown {
    if (!path) {
      return context;
    }

    // Handle array indexing and dot notation
    const segments = this.parseVariablePath(path);
    let current: unknown = context;

    for (const segment of segments) {
      if (current === null || current === undefined) {
        return undefined;
      }

      if (segment.type === "property") {
        current =
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[segment.key!]
            : undefined;
      } else if (segment.type === "index") {
        if (!Array.isArray(current)) {
          throw new Error(`Cannot index non-array value at path: ${path}`);
        }
        current = current[segment.index!];
      }
    }

    return current;
  }

  /**
   * Set nested variable paths (e.g., "user.profile.name" = "John")
   */
  static setVariablePath(context: Record<string, unknown>, path: string, value: unknown): void {
    if (!path) {
      throw new Error("Cannot set empty path");
    }

    const segments = this.parseVariablePath(path);
    let current: unknown = context;

    // Navigate to parent of target
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];

      if (segment.type === "property") {
        const currentObj = current as Record<string, unknown>;
        if (
          !(segment.key! in currentObj) ||
          currentObj[segment.key!] === null ||
          currentObj[segment.key!] === undefined
        ) {
          // Create object if it doesn't exist
          currentObj[segment.key!] = {};
        }
        current = currentObj[segment.key!];
      } else if (segment.type === "index") {
        if (!Array.isArray(current)) {
          throw new Error(`Cannot index non-array value in path: ${path}`);
        }
        if (segment.index! >= current.length) {
          throw new Error(`Array index ${segment.index} out of bounds in path: ${path}`);
        }
        current = current[segment.index!];
      }
    }

    // Set final value
    const lastSegment = segments[segments.length - 1];
    if (lastSegment.type === "property") {
      (current as Record<string, unknown>)[lastSegment.key!] = value;
    } else if (lastSegment.type === "index") {
      if (!Array.isArray(current)) {
        throw new Error(`Cannot set array index on non-array value in path: ${path}`);
      }
      current[lastSegment.index!] = value;
    }
  }

  /**
   * Parse variable path into segments handling both dot notation and array indexing
   * Examples:
   * "user.profile.name" → [{type: 'property', key: 'user'}, {type: 'property', key: 'profile'}, {type: 'property', key: 'name'}]
   * "items[0].name" → [{type: 'property', key: 'items'}, {type: 'index', index: 0}, {type: 'property', key: 'name'}]
   */
  static parseVariablePath(path: string): PathSegment[] {
    const segments: PathSegment[] = [];
    let current = "";
    let i = 0;

    while (i < path.length) {
      const char = path[i];

      if (char === ".") {
        if (current) {
          segments.push({ type: "property", key: current });
          current = "";
        }
      } else if (char === "[") {
        if (current) {
          segments.push({ type: "property", key: current });
          current = "";
        }

        // Parse array index
        i++; // Skip '['
        let indexStr = "";
        while (i < path.length && path[i] !== "]") {
          indexStr += path[i];
          i++;
        }

        if (i >= path.length) {
          throw new Error(`Unclosed array index in path: ${path}`);
        }

        const index = parseInt(indexStr, 10);
        if (isNaN(index) || index < 0) {
          throw new Error(`Invalid array index "${indexStr}" in path: ${path}`);
        }

        segments.push({ type: "index", index });
        // i is now at ']', will be incremented at end of loop
      } else {
        current += char;
      }

      i++;
    }

    if (current) {
      segments.push({ type: "property", key: current });
    }

    return segments;
  }

  /**
   * Validate that path can be resolved without errors
   */
  static validatePath(path: string): { valid: boolean; error?: string } {
    if (!path) {
      return { valid: false, error: "Path cannot be empty" };
    }

    try {
      this.parseVariablePath(path);
      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if path exists in context
   */
  static pathExists(context: Record<string, unknown>, path: string): boolean {
    try {
      const value = this.resolveVariablePath(context, path);
      return value !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Get all available paths in context (for debugging)
   */
  static getAvailablePaths(
    context: Record<string, unknown>,
    prefix: string = "",
    maxDepth: number = 3,
  ): string[] {
    if (maxDepth <= 0) return [];

    const paths: string[] = [];

    for (const [key, value] of Object.entries(context)) {
      const currentPath = prefix ? `${prefix}.${key}` : key;
      paths.push(currentPath);

      if (value && typeof value === "object" && !Array.isArray(value)) {
        // Recurse into objects
        const subPaths = this.getAvailablePaths(
          value as Record<string, unknown>,
          currentPath,
          maxDepth - 1,
        );
        paths.push(...subPaths);
      } else if (Array.isArray(value)) {
        // Add array indices
        for (let i = 0; i < Math.min(value.length, 5); i++) {
          const indexPath = `${currentPath}[${i}]`;
          paths.push(indexPath);

          if (value[i] && typeof value[i] === "object") {
            const subPaths = this.getAvailablePaths(
              value[i] as Record<string, unknown>,
              indexPath,
              maxDepth - 1,
            );
            paths.push(...subPaths);
          }
        }
      }
    }

    return paths;
  }
}
