/**
 * Unit Tests for PathResolver Utility
 * Test path parsing, resolution, and setting functionality
 */

import { describe, test, expect } from "@jest/globals";
import { PathResolver } from "@mcp-moira/workflow-engine";

describe("PathResolver", () => {
  describe("Path Parsing", () => {
    test("should parse simple property paths", () => {
      const segments = PathResolver.parseVariablePath("userName");

      expect(segments).toEqual([{ type: "property", key: "userName" }]);
    });

    test("should parse nested property paths", () => {
      const segments = PathResolver.parseVariablePath("user.profile.name");

      expect(segments).toEqual([
        { type: "property", key: "user" },
        { type: "property", key: "profile" },
        { type: "property", key: "name" },
      ]);
    });

    test("should parse array indexing paths", () => {
      const segments = PathResolver.parseVariablePath("items[0]");

      expect(segments).toEqual([
        { type: "property", key: "items" },
        { type: "index", index: 0 },
      ]);
    });

    test("should parse mixed property and array paths", () => {
      const segments = PathResolver.parseVariablePath("users[0].profile.settings[2]");

      expect(segments).toEqual([
        { type: "property", key: "users" },
        { type: "index", index: 0 },
        { type: "property", key: "profile" },
        { type: "property", key: "settings" },
        { type: "index", index: 2 },
      ]);
    });

    test("should handle empty property names gracefully", () => {
      expect(() => PathResolver.parseVariablePath("")).not.toThrow();
      expect(PathResolver.parseVariablePath("")).toEqual([]);
    });

    test("should throw error for unclosed array index", () => {
      expect(() => PathResolver.parseVariablePath("items[0")).toThrow("Unclosed array index");
    });

    test("should throw error for invalid array index", () => {
      expect(() => PathResolver.parseVariablePath("items[abc]")).toThrow(
        'Invalid array index "abc"',
      );
      expect(() => PathResolver.parseVariablePath("items[-1]")).toThrow('Invalid array index "-1"');
    });
  });

  describe("Path Resolution", () => {
    const testContext = {
      userName: "John",
      user: {
        profile: {
          name: "John Doe",
          age: 30,
          settings: ["theme", "language", "timezone"],
        },
      },
      items: [
        { name: "Item 1", value: 100 },
        { name: "Item 2", value: 200 },
      ],
      emptyValue: null,
      undefinedValue: undefined,
    };

    test("should resolve simple property paths", () => {
      expect(PathResolver.resolveVariablePath(testContext, "userName")).toBe("John");
    });

    test("should resolve nested property paths", () => {
      expect(PathResolver.resolveVariablePath(testContext, "user.profile.name")).toBe("John Doe");
      expect(PathResolver.resolveVariablePath(testContext, "user.profile.age")).toBe(30);
    });

    test("should resolve array indexing paths", () => {
      expect(PathResolver.resolveVariablePath(testContext, "items[0]")).toEqual({
        name: "Item 1",
        value: 100,
      });
      expect(PathResolver.resolveVariablePath(testContext, "items[1].name")).toBe("Item 2");
      expect(PathResolver.resolveVariablePath(testContext, "items[1].value")).toBe(200);
    });

    test("should resolve mixed complex paths", () => {
      expect(PathResolver.resolveVariablePath(testContext, "user.profile.settings[1]")).toBe(
        "language",
      );
    });

    test("should return undefined for non-existent paths", () => {
      expect(PathResolver.resolveVariablePath(testContext, "nonexistent")).toBeUndefined();
      expect(PathResolver.resolveVariablePath(testContext, "user.nonexistent")).toBeUndefined();
      expect(
        PathResolver.resolveVariablePath(testContext, "user.profile.nonexistent"),
      ).toBeUndefined();
    });

    test("should return undefined for null/undefined intermediate values", () => {
      expect(PathResolver.resolveVariablePath(testContext, "emptyValue.property")).toBeUndefined();
      expect(
        PathResolver.resolveVariablePath(testContext, "undefinedValue.property"),
      ).toBeUndefined();
    });

    test("should throw error for array indexing on non-array", () => {
      expect(() => PathResolver.resolveVariablePath(testContext, "userName[0]")).toThrow(
        "Cannot index non-array value",
      );
    });

    test("should return context for empty path", () => {
      expect(PathResolver.resolveVariablePath(testContext, "")).toBe(testContext);
    });
  });

  describe("Path Setting", () => {
    let context: any;

    beforeEach(() => {
      context = {
        user: {
          profile: { name: "John" },
        },
        items: [{ value: 100 }, { value: 200 }],
      };
    });

    test("should set simple property paths", () => {
      PathResolver.setVariablePath(context, "newProperty", "newValue");
      expect(context.newProperty).toBe("newValue");
    });

    test("should set nested property paths", () => {
      PathResolver.setVariablePath(context, "user.profile.age", 30);
      expect(context.user.profile.age).toBe(30);
    });

    test("should create intermediate objects when needed", () => {
      PathResolver.setVariablePath(context, "user.settings.theme", "dark");
      expect(context.user.settings.theme).toBe("dark");
    });

    test("should set array element values", () => {
      PathResolver.setVariablePath(context, "items[0].value", 150);
      expect(context.items[0].value).toBe(150);
    });

    test("should create nested object paths", () => {
      PathResolver.setVariablePath(context, "newUser.profile.name", "Jane");
      expect(context.newUser.profile.name).toBe("Jane");
    });

    test("should throw error for empty path", () => {
      expect(() => PathResolver.setVariablePath(context, "", "value")).toThrow(
        "Cannot set empty path",
      );
    });

    test("should throw error for array indexing on non-array", () => {
      expect(() => PathResolver.setVariablePath(context, "user.profile[0]", "value")).toThrow(
        "Cannot set array index on non-array value",
      );
    });

    test("should throw error for out of bounds array index", () => {
      expect(() => PathResolver.setVariablePath(context, "items[5].value", "value")).toThrow(
        "Array index 5 out of bounds",
      );
    });
  });

  describe("Path Validation", () => {
    test("should validate correct paths", () => {
      expect(PathResolver.validatePath("userName")).toEqual({ valid: true });
      expect(PathResolver.validatePath("user.profile.name")).toEqual({ valid: true });
      expect(PathResolver.validatePath("items[0].value")).toEqual({ valid: true });
    });

    test("should detect invalid paths", () => {
      const result1 = PathResolver.validatePath("");
      expect(result1.valid).toBe(false);
      expect(result1.error).toBe("Path cannot be empty");

      const result2 = PathResolver.validatePath("items[abc]");
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain('Invalid array index "abc"');

      const result3 = PathResolver.validatePath("items[0");
      expect(result3.valid).toBe(false);
      expect(result3.error).toContain("Unclosed array index");
    });
  });

  describe("Path Existence", () => {
    const testContext = {
      userName: "John",
      user: { profile: { name: "John Doe" } },
      items: [{ value: 100 }],
    };

    test("should detect existing paths", () => {
      expect(PathResolver.pathExists(testContext, "userName")).toBe(true);
      expect(PathResolver.pathExists(testContext, "user.profile.name")).toBe(true);
      expect(PathResolver.pathExists(testContext, "items[0].value")).toBe(true);
    });

    test("should detect non-existing paths", () => {
      expect(PathResolver.pathExists(testContext, "nonexistent")).toBe(false);
      expect(PathResolver.pathExists(testContext, "user.nonexistent")).toBe(false);
      expect(PathResolver.pathExists(testContext, "items[5]")).toBe(false);
    });

    test("should handle invalid paths gracefully", () => {
      expect(PathResolver.pathExists(testContext, "userName[0]")).toBe(false);
    });
  });

  describe("Available Paths Discovery", () => {
    const testContext = {
      userName: "John",
      user: {
        profile: { name: "John Doe", age: 30 },
      },
      items: [{ value: 100 }, { value: 200 }],
    };

    test("should discover all available paths", () => {
      const paths = PathResolver.getAvailablePaths(testContext);

      expect(paths).toContain("userName");
      expect(paths).toContain("user");
      expect(paths).toContain("user.profile");
      expect(paths).toContain("user.profile.name");
      expect(paths).toContain("user.profile.age");
      expect(paths).toContain("items");
      expect(paths).toContain("items[0]");
      expect(paths).toContain("items[1]");
      expect(paths).toContain("items[0].value");
      expect(paths).toContain("items[1].value");
    });

    test("should respect maximum depth limit", () => {
      const deepContext = {
        level1: {
          level2: {
            level3: {
              level4: "deep-value",
            },
          },
        },
      };

      const paths = PathResolver.getAvailablePaths(deepContext, "", 2);

      expect(paths).toContain("level1");
      expect(paths).toContain("level1.level2");
      expect(paths).not.toContain("level1.level2.level3");
    });

    test("should limit array index discovery", () => {
      const largeArrayContext = {
        items: Array.from({ length: 10 }, (_, i) => ({ id: i })),
      };

      const paths = PathResolver.getAvailablePaths(largeArrayContext);

      // Should only discover first 5 indices
      expect(paths).toContain("items[0]");
      expect(paths).toContain("items[4]");
      expect(paths).not.toContain("items[5]");
      expect(paths).not.toContain("items[9]");
    });
  });
});
