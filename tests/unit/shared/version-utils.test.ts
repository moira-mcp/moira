/**
 * Version Utilities Tests
 */

import { describe, it, expect } from "@jest/globals";
import {
  isValidSemver,
  parseSemver,
  compareSemver,
  isVersionIncremented,
  incrementPatchVersion,
  normalizeWorkflowForComparison,
  hasWorkflowContentChanged,
  validateVersionChange,
} from "@mcp-moira/shared";

describe("Version Utilities", () => {
  describe("isValidSemver", () => {
    it("should return true for valid semver strings", () => {
      expect(isValidSemver("0.0.0")).toBe(true);
      expect(isValidSemver("1.0.0")).toBe(true);
      expect(isValidSemver("1.2.3")).toBe(true);
      expect(isValidSemver("10.20.30")).toBe(true);
      expect(isValidSemver("100.200.300")).toBe(true);
    });

    it("should return false for invalid semver strings", () => {
      expect(isValidSemver("")).toBe(false);
      expect(isValidSemver("1")).toBe(false);
      expect(isValidSemver("1.0")).toBe(false);
      expect(isValidSemver("1.0.0.0")).toBe(false);
      expect(isValidSemver("v1.0.0")).toBe(false);
      expect(isValidSemver("1.0.0-alpha")).toBe(false);
      expect(isValidSemver("1.0.0+build")).toBe(false);
      expect(isValidSemver("01.0.0")).toBe(false);
      expect(isValidSemver("1.00.0")).toBe(false);
      expect(isValidSemver("1.0.00")).toBe(false);
      expect(isValidSemver("a.b.c")).toBe(false);
      expect(isValidSemver("-1.0.0")).toBe(false);
    });

    it("should return false for non-string values", () => {
      expect(isValidSemver(null)).toBe(false);
      expect(isValidSemver(undefined)).toBe(false);
      expect(isValidSemver(100)).toBe(false);
      expect(isValidSemver({})).toBe(false);
      expect(isValidSemver([])).toBe(false);
    });
  });

  describe("parseSemver", () => {
    it("should parse valid semver strings", () => {
      expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
      expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
      expect(parseSemver("10.20.30")).toEqual({
        major: 10,
        minor: 20,
        patch: 30,
      });
    });

    it("should return null for invalid semver strings", () => {
      expect(parseSemver("")).toBeNull();
      expect(parseSemver("1.0")).toBeNull();
      expect(parseSemver("v1.0.0")).toBeNull();
      expect(parseSemver("1.0.0-alpha")).toBeNull();
    });
  });

  describe("compareSemver", () => {
    it("should return 0 for equal versions", () => {
      expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
      expect(compareSemver("0.0.0", "0.0.0")).toBe(0);
      expect(compareSemver("10.20.30", "10.20.30")).toBe(0);
    });

    it("should return 1 when first version is greater", () => {
      expect(compareSemver("2.0.0", "1.0.0")).toBe(1);
      expect(compareSemver("1.1.0", "1.0.0")).toBe(1);
      expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
      expect(compareSemver("1.0.10", "1.0.9")).toBe(1);
      expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
      expect(compareSemver("10.0.0", "9.0.0")).toBe(1);
    });

    it("should return -1 when first version is less", () => {
      expect(compareSemver("1.0.0", "2.0.0")).toBe(-1);
      expect(compareSemver("1.0.0", "1.1.0")).toBe(-1);
      expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
      expect(compareSemver("1.0.9", "1.0.10")).toBe(-1);
      expect(compareSemver("1.9.0", "1.10.0")).toBe(-1);
      expect(compareSemver("9.0.0", "10.0.0")).toBe(-1);
    });

    it("should throw for invalid versions", () => {
      expect(() => compareSemver("invalid", "1.0.0")).toThrow("Invalid semver version: invalid");
      expect(() => compareSemver("1.0.0", "invalid")).toThrow("Invalid semver version: invalid");
    });
  });

  describe("isVersionIncremented", () => {
    it("should return true when new version is greater", () => {
      expect(isVersionIncremented("1.0.0", "1.0.1")).toBe(true);
      expect(isVersionIncremented("1.0.0", "1.1.0")).toBe(true);
      expect(isVersionIncremented("1.0.0", "2.0.0")).toBe(true);
    });

    it("should return false when versions are equal", () => {
      expect(isVersionIncremented("1.0.0", "1.0.0")).toBe(false);
    });

    it("should return false when new version is less", () => {
      expect(isVersionIncremented("1.0.1", "1.0.0")).toBe(false);
      expect(isVersionIncremented("2.0.0", "1.0.0")).toBe(false);
    });
  });

  describe("incrementPatchVersion", () => {
    it("should increment patch version", () => {
      expect(incrementPatchVersion("1.0.0")).toBe("1.0.1");
      expect(incrementPatchVersion("1.0.9")).toBe("1.0.10");
      expect(incrementPatchVersion("0.0.0")).toBe("0.0.1");
      expect(incrementPatchVersion("10.20.30")).toBe("10.20.31");
    });

    it("should throw for invalid version", () => {
      expect(() => incrementPatchVersion("invalid")).toThrow("Invalid semver version: invalid");
      expect(() => incrementPatchVersion("1.0")).toThrow("Invalid semver version: 1.0");
    });
  });

  describe("normalizeWorkflowForComparison", () => {
    it("should exclude version field", () => {
      const workflow1 = { metadata: { version: "1.0.0", name: "test" } };
      const workflow2 = { metadata: { version: "2.0.0", name: "test" } };

      expect(normalizeWorkflowForComparison(workflow1)).toBe(
        normalizeWorkflowForComparison(workflow2),
      );
    });

    it("should exclude timestamp fields", () => {
      const workflow1 = {
        name: "test",
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
      };
      const workflow2 = {
        name: "test",
        createdAt: "2024-12-31",
        updatedAt: "2024-12-31",
      };

      expect(normalizeWorkflowForComparison(workflow1)).toBe(
        normalizeWorkflowForComparison(workflow2),
      );
    });

    it("should sort object keys for consistent comparison", () => {
      const workflow1 = { b: 2, a: 1 };
      const workflow2 = { a: 1, b: 2 };

      expect(normalizeWorkflowForComparison(workflow1)).toBe(
        normalizeWorkflowForComparison(workflow2),
      );
    });

    it("should handle nested objects", () => {
      const workflow1 = {
        metadata: { name: "test", version: "1.0.0" },
        nodes: [{ id: "1", version: "node-version" }],
      };
      const workflow2 = {
        metadata: { version: "2.0.0", name: "test" },
        nodes: [{ version: "node-version", id: "1" }],
      };

      expect(normalizeWorkflowForComparison(workflow1)).toBe(
        normalizeWorkflowForComparison(workflow2),
      );
    });

    it("should handle null and undefined", () => {
      expect(normalizeWorkflowForComparison(null)).toBe("null");
      expect(normalizeWorkflowForComparison(undefined)).toBe("undefined");
    });

    it("should handle arrays", () => {
      const workflow = { nodes: [{ id: "1" }, { id: "2" }] };
      const result = normalizeWorkflowForComparison(workflow);
      expect(result).toContain("nodes");
    });
  });

  describe("hasWorkflowContentChanged", () => {
    it("should return false when content is the same", () => {
      const workflow1 = {
        metadata: { name: "test", version: "1.0.0" },
        nodes: [{ id: "1", directive: "do something" }],
      };
      const workflow2 = {
        metadata: { name: "test", version: "2.0.0" },
        nodes: [{ id: "1", directive: "do something" }],
      };

      expect(hasWorkflowContentChanged(workflow1, workflow2)).toBe(false);
    });

    it("should return true when content is different", () => {
      const workflow1 = {
        metadata: { name: "test", version: "1.0.0" },
        nodes: [{ id: "1", directive: "do something" }],
      };
      const workflow2 = {
        metadata: { name: "test", version: "1.0.0" },
        nodes: [{ id: "1", directive: "do something else" }],
      };

      expect(hasWorkflowContentChanged(workflow1, workflow2)).toBe(true);
    });

    it("should return true when metadata name changes", () => {
      const workflow1 = { metadata: { name: "test1", version: "1.0.0" } };
      const workflow2 = { metadata: { name: "test2", version: "1.0.0" } };

      expect(hasWorkflowContentChanged(workflow1, workflow2)).toBe(true);
    });

    it("should return true when nodes are added", () => {
      const workflow1 = { nodes: [{ id: "1" }] };
      const workflow2 = { nodes: [{ id: "1" }, { id: "2" }] };

      expect(hasWorkflowContentChanged(workflow1, workflow2)).toBe(true);
    });

    it("should return true when nodes are removed", () => {
      const workflow1 = { nodes: [{ id: "1" }, { id: "2" }] };
      const workflow2 = { nodes: [{ id: "1" }] };

      expect(hasWorkflowContentChanged(workflow1, workflow2)).toBe(true);
    });
  });

  describe("Migration scenario: same version, different content", () => {
    it("should detect content mismatch at same version (migration fail condition)", () => {
      // This is the exact scenario that caused the deployment bug:
      // Server had v7.36.0 with 153 nodes, local had v7.36.0 with 157 nodes
      const serverWorkflow = {
        metadata: { name: "software-development-flow", version: "7.36.0" },
        nodes: Array.from({ length: 153 }, (_, i) => ({ id: `node-${i}`, directive: `step ${i}` })),
      };
      const localWorkflow = {
        metadata: { name: "software-development-flow", version: "7.36.0" },
        nodes: Array.from({ length: 157 }, (_, i) => ({ id: `node-${i}`, directive: `step ${i}` })),
      };

      // Same version
      expect(compareSemver("7.36.0", "7.36.0")).toBe(0);
      // Different content
      expect(hasWorkflowContentChanged(serverWorkflow, localWorkflow)).toBe(true);
    });

    it("should NOT detect mismatch when content is identical at same version", () => {
      const workflow = {
        metadata: { name: "test-flow", version: "1.0.0" },
        nodes: [{ id: "n1", directive: "do thing" }],
      };
      // Simulate server copy with different id/timestamps (stripped by normalization)
      const serverCopy = {
        id: "uuid-from-server",
        metadata: { name: "test-flow", version: "1.0.0" },
        nodes: [{ id: "n1", directive: "do thing" }],
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2025-02-28T00:00:00Z",
      };

      expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
      expect(hasWorkflowContentChanged(serverCopy, workflow)).toBe(false);
    });

    it("should allow migration when local version is newer (normal upgrade)", () => {
      expect(compareSemver("7.37.0", "7.36.0")).toBe(1);
    });

    it("should skip when local version is older than server", () => {
      expect(compareSemver("7.35.0", "7.36.0")).toBe(-1);
    });

    it("should detect subtle content changes like modified directives", () => {
      const server = {
        metadata: { name: "flow", version: "2.0.0" },
        nodes: [{ id: "n1", directive: "original text" }],
      };
      const local = {
        metadata: { name: "flow", version: "2.0.0" },
        nodes: [{ id: "n1", directive: "modified text" }],
      };

      expect(hasWorkflowContentChanged(server, local)).toBe(true);
    });

    it("should detect added nodes as content change", () => {
      const server = {
        metadata: { name: "flow", version: "3.0.0" },
        nodes: [{ id: "n1" }],
      };
      const local = {
        metadata: { name: "flow", version: "3.0.0" },
        nodes: [{ id: "n1" }, { id: "n2" }],
      };

      expect(hasWorkflowContentChanged(server, local)).toBe(true);
    });
  });

  describe("validateVersionChange", () => {
    it("should require version in metadata", () => {
      const result = validateVersionChange({ metadata: {} }, { metadata: {} });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Version is required");
    });

    it("should validate semver format", () => {
      const result = validateVersionChange(
        { metadata: { version: "1.0.0" } },
        { metadata: { version: "invalid" } },
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid semver version");
    });

    it("should allow any valid version for new workflows", () => {
      const result = validateVersionChange({ metadata: {} }, { metadata: { version: "1.0.0" } });

      expect(result.valid).toBe(true);
    });

    it("should allow same version when content unchanged", () => {
      const workflow = {
        metadata: { name: "test", version: "1.0.0" },
        nodes: [{ id: "1" }],
      };

      const result = validateVersionChange(workflow, workflow);

      expect(result.valid).toBe(true);
    });

    it("should require version increment when content changes", () => {
      const original = {
        metadata: { name: "test", version: "1.0.0" },
        nodes: [{ id: "1", directive: "old" }],
      };
      const modified = {
        metadata: { name: "test", version: "1.0.0" },
        nodes: [{ id: "1", directive: "new" }],
      };

      const result = validateVersionChange(original, modified);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Content changed but version not incremented");
      expect(result.error).toContain("--force");
    });

    it("should pass when version is incremented with content changes", () => {
      const original = {
        metadata: { name: "test", version: "1.0.0" },
        nodes: [{ id: "1", directive: "old" }],
      };
      const modified = {
        metadata: { name: "test", version: "1.0.1" },
        nodes: [{ id: "1", directive: "new" }],
      };

      const result = validateVersionChange(original, modified);

      expect(result.valid).toBe(true);
    });

    it("should allow version increment without content changes", () => {
      const original = {
        metadata: { name: "test", version: "1.0.0" },
        nodes: [{ id: "1" }],
      };
      const modified = {
        metadata: { name: "test", version: "1.0.1" },
        nodes: [{ id: "1" }],
      };

      const result = validateVersionChange(original, modified);

      expect(result.valid).toBe(true);
    });
  });
});
