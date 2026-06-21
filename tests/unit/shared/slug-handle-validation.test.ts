/**
 * Unit Tests: Slug and Handle Validation
 * Tests validation, normalization, and utility functions for slugs and handles
 */

import { describe, it, expect } from "@jest/globals";
import {
  validateSlug,
  validateHandle,
  normalizeSlug,
  normalizeHandle,
  generateDefaultSlug,
  generateSlugFromName,
  parseWorkflowReference,
  createWorkflowReference,
  SLUG_MIN_LENGTH,
  SLUG_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  HANDLE_MAX_LENGTH,
} from "@mcp-moira/shared";

describe("Slug Validation", () => {
  describe("validateSlug", () => {
    it("accepts valid slug with lowercase letters", () => {
      expect(validateSlug("valid")).toEqual({ valid: true });
    });

    it("accepts valid slug with numbers", () => {
      expect(validateSlug("test123")).toEqual({ valid: true });
    });

    it("accepts valid slug with hyphens", () => {
      expect(validateSlug("my-workflow")).toEqual({ valid: true });
    });

    it("accepts minimum length slug", () => {
      const minSlug = "a".repeat(SLUG_MIN_LENGTH);
      expect(validateSlug(minSlug)).toEqual({ valid: true });
    });

    it("accepts maximum length slug", () => {
      const maxSlug = "a".repeat(SLUG_MAX_LENGTH);
      expect(validateSlug(maxSlug)).toEqual({ valid: true });
    });

    it("rejects slug shorter than minimum", () => {
      const shortSlug = "a".repeat(SLUG_MIN_LENGTH - 1);
      const result = validateSlug(shortSlug);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("at least");
    });

    it("rejects slug longer than maximum", () => {
      const longSlug = "a".repeat(SLUG_MAX_LENGTH + 1);
      const result = validateSlug(longSlug);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("at most");
    });

    it("rejects slug starting with hyphen", () => {
      const result = validateSlug("-invalid");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("start and end with a letter or number");
    });

    it("rejects slug ending with hyphen", () => {
      const result = validateSlug("invalid-");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("start and end with a letter or number");
    });

    it("rejects slug with consecutive hyphens", () => {
      const result = validateSlug("my--workflow");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("consecutive hyphens");
    });

    it("accepts uppercase slug after normalization", () => {
      // The validation lowercases before checking pattern, so MyWorkflow becomes myworkflow and is valid
      const result = validateSlug("MyWorkflow");
      expect(result.valid).toBe(true);
    });

    it("rejects slug with underscores", () => {
      const result = validateSlug("my_workflow");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("lowercase letters, numbers, and hyphens");
    });

    it("rejects slug with spaces", () => {
      const result = validateSlug("my workflow");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("lowercase letters, numbers, and hyphens");
    });

    it("rejects slug with special characters", () => {
      const result = validateSlug("my@workflow");
      expect(result.valid).toBe(false);
    });

    it("rejects empty slug", () => {
      const result = validateSlug("");
      expect(result.valid).toBe(false);
    });
  });

  describe("normalizeSlug", () => {
    it("converts to lowercase", () => {
      expect(normalizeSlug("MyWorkflow")).toBe("myworkflow");
    });

    it("trims whitespace", () => {
      expect(normalizeSlug("  test  ")).toBe("test");
    });

    it("does basic normalization only (lowercase and trim)", () => {
      // normalizeSlug only lowercases and trims, does not transform characters
      expect(normalizeSlug("my_workflow")).toBe("my_workflow");
    });
  });

  describe("generateDefaultSlug", () => {
    it("generates slug with workflow- prefix", () => {
      const slug = generateDefaultSlug();
      expect(slug).toMatch(/^workflow-[a-z0-9]{8}$/);
    });

    it("generates unique slugs", () => {
      const slugs = new Set<string>();
      for (let i = 0; i < 100; i++) {
        slugs.add(generateDefaultSlug());
      }
      expect(slugs.size).toBe(100);
    });
  });

  describe("generateSlugFromName", () => {
    it("generates slug from simple name", () => {
      expect(generateSlugFromName("My Workflow")).toBe("my-workflow");
    });

    it("converts special characters to hyphens", () => {
      // Special characters are replaced with hyphens and then cleaned up
      expect(generateSlugFromName("Test@Workflow!")).toBe("test-workflow");
    });

    it("truncates long names", () => {
      const longName = "a".repeat(100);
      const slug = generateSlugFromName(longName);
      expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    });

    it("falls back to default slug for empty result", () => {
      const slug = generateSlugFromName("@@@");
      expect(slug).toMatch(/^workflow-[a-z0-9]{8}$/);
    });

    it("adds random suffix for short names", () => {
      const slug = generateSlugFromName("ab");
      // Short names get random suffix to meet minimum length
      expect(slug.length).toBeGreaterThanOrEqual(SLUG_MIN_LENGTH);
    });
  });
});

describe("Handle Validation", () => {
  describe("validateHandle", () => {
    it("accepts valid handle with lowercase letters", () => {
      expect(validateHandle("john")).toEqual({ valid: true });
    });

    it("accepts valid handle with numbers", () => {
      expect(validateHandle("john123")).toEqual({ valid: true });
    });

    it("accepts valid handle with hyphens", () => {
      expect(validateHandle("john-doe")).toEqual({ valid: true });
    });

    it("accepts minimum length handle", () => {
      const minHandle = "a".repeat(HANDLE_MIN_LENGTH);
      expect(validateHandle(minHandle)).toEqual({ valid: true });
    });

    it("accepts maximum length handle", () => {
      const maxHandle = "a".repeat(HANDLE_MAX_LENGTH);
      expect(validateHandle(maxHandle)).toEqual({ valid: true });
    });

    it("rejects handle shorter than minimum", () => {
      const shortHandle = "a".repeat(HANDLE_MIN_LENGTH - 1);
      const result = validateHandle(shortHandle);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("at least");
    });

    it("rejects handle longer than maximum", () => {
      const longHandle = "a".repeat(HANDLE_MAX_LENGTH + 1);
      const result = validateHandle(longHandle);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("at most");
    });

    it("rejects handle starting with hyphen", () => {
      const result = validateHandle("-john");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("start and end with a letter or number");
    });

    it("rejects handle ending with hyphen", () => {
      const result = validateHandle("john-");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("start and end with a letter or number");
    });

    it("rejects handle with consecutive hyphens", () => {
      const result = validateHandle("john--doe");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("consecutive hyphens");
    });

    it("accepts uppercase handle after normalization", () => {
      // Validation lowercases before checking pattern
      const result = validateHandle("JohnDoe");
      expect(result.valid).toBe(true);
    });

    it("rejects handle with underscores", () => {
      const result = validateHandle("john_doe");
      expect(result.valid).toBe(false);
    });
  });

  describe("normalizeHandle", () => {
    it("converts to lowercase", () => {
      expect(normalizeHandle("JohnDoe")).toBe("johndoe");
    });

    it("trims whitespace", () => {
      expect(normalizeHandle("  john  ")).toBe("john");
    });

    it("does basic normalization only (lowercase and trim)", () => {
      // normalizeHandle only lowercases and trims, does not transform characters
      expect(normalizeHandle("john_doe")).toBe("john_doe");
    });
  });
});

describe("Workflow Reference", () => {
  describe("parseWorkflowReference", () => {
    it("parses valid handle/slug reference", () => {
      expect(parseWorkflowReference("john-doe/my-workflow")).toEqual({
        handle: "john-doe",
        slug: "my-workflow",
      });
    });

    it("parses reference with numbers", () => {
      expect(parseWorkflowReference("user123/workflow456")).toEqual({
        handle: "user123",
        slug: "workflow456",
      });
    });

    it("returns null for invalid format (no slash)", () => {
      expect(parseWorkflowReference("invalid")).toBeNull();
    });

    it("returns null for empty handle", () => {
      expect(parseWorkflowReference("/my-workflow")).toBeNull();
    });

    it("returns null for empty slug", () => {
      expect(parseWorkflowReference("john-doe/")).toBeNull();
    });

    it("returns null for multiple slashes", () => {
      expect(parseWorkflowReference("john/doe/workflow")).toBeNull();
    });

    it("returns null for too short handle", () => {
      // Handle must be at least 4 chars
      expect(parseWorkflowReference("jd/my-workflow")).toBeNull();
    });

    it("returns null for too short slug", () => {
      // Slug must be at least 4 chars
      expect(parseWorkflowReference("john-doe/wf")).toBeNull();
    });
  });

  describe("createWorkflowReference", () => {
    it("creates valid reference", () => {
      expect(createWorkflowReference("john-doe", "my-workflow")).toBe("john-doe/my-workflow");
    });

    it("normalizes handle and slug to lowercase", () => {
      expect(createWorkflowReference("JohnDoe", "MyWorkflow")).toBe("johndoe/myworkflow");
    });
  });
});

describe("Constants", () => {
  it("SLUG_MIN_LENGTH is 4", () => {
    expect(SLUG_MIN_LENGTH).toBe(4);
  });

  it("SLUG_MAX_LENGTH is 80", () => {
    expect(SLUG_MAX_LENGTH).toBe(80);
  });

  it("HANDLE_MIN_LENGTH is 4", () => {
    expect(HANDLE_MIN_LENGTH).toBe(4);
  });

  it("HANDLE_MAX_LENGTH is 40", () => {
    expect(HANDLE_MAX_LENGTH).toBe(40);
  });
});
