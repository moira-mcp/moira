/**
 * Unit Tests for ContextMapper
 * Test context isolation and variable mapping functionality
 */

import { describe, test, expect } from "@jest/globals";
import { ContextMapper, ContextHelpers } from "@mcp-moira/workflow-engine";

describe("ContextMapper", () => {
  describe("Child Context Creation", () => {
    test("should create isolated child context with mapped variables", () => {
      const parentContext = ContextHelpers.createTestContext("parent-workflow", "parent-exec", {
        userName: "John",
        user: {
          profile: { name: "John Doe", age: 30 },
        },
        items: [{ value: 100 }, { value: 200 }],
      });

      const inputMapping = {
        userName: "childUserName",
        "user.profile.name": "fullName",
        "user.profile.age": "age",
        "items[0].value": "firstItemValue",
      };

      const childContext = ContextMapper.createChildContext(
        parentContext,
        inputMapping,
        "child-workflow",
        "child-exec",
      );

      // Verify child context structure
      expect(childContext.executionId).toBe("child-exec");
      expect(childContext.workflowId).toBe("child-workflow");
      expect(childContext._subgraphDepth).toBe(1);
      expect(childContext._parentExecutionId).toBe("parent-exec");
      expect(childContext._subgraphChain).toEqual(["parent-workflow", "child-workflow"]);

      // Verify mapped variables
      expect(childContext.variables.childUserName).toBe("John");
      expect(childContext.variables.fullName).toBe("John Doe");
      expect(childContext.variables.age).toBe(30);
      expect(childContext.variables.firstItemValue).toBe(100);

      // Verify isolation - child should not have unmapped parent variables
      expect(childContext.variables.user).toBeUndefined();
      expect(childContext.variables.items).toBeUndefined();
    });

    test("should handle missing parent variables gracefully", () => {
      const parentContext = ContextHelpers.createTestContext("parent", "parent-exec", {
        existingVar: "value",
      });

      const inputMapping = {
        "nonexistent.path": "childVar",
        existingVar: "mappedVar",
      };

      const childContext = ContextMapper.createChildContext(
        parentContext,
        inputMapping,
        "child-workflow",
        "child-exec",
      );

      expect(childContext.variables.childVar).toBeUndefined();
      expect(childContext.variables.mappedVar).toBe("value");
    });

    test("should increment depth correctly", () => {
      const parentContext = ContextHelpers.createTestContext();
      parentContext._subgraphDepth = 5;

      const childContext = ContextMapper.createChildContext(
        parentContext,
        {},
        "child-workflow",
        "child-exec",
      );

      expect(childContext._subgraphDepth).toBe(6);
    });

    test("should maintain workflow execution chain", () => {
      const parentContext = ContextHelpers.createTestContext();
      parentContext._subgraphChain = ["root", "intermediate"];

      const childContext = ContextMapper.createChildContext(
        parentContext,
        {},
        "child-workflow",
        "child-exec",
      );

      expect(childContext._subgraphChain).toEqual(["root", "intermediate", "child-workflow"]);
    });
  });

  describe("Child Result Merging", () => {
    test("should merge child results to parent context", () => {
      const parentContext = ContextHelpers.createTestContext("parent", "parent-exec", {
        existingData: "preserved",
        output: {},
      });

      const childContext = ContextHelpers.createTestContext("child", "child-exec", {
        result: "child-success",
        status: "completed",
        details: {
          score: 95,
          metrics: [10, 20, 30],
        },
      });

      const outputMapping = {
        result: "output.result",
        status: "status",
        "details.score": "finalScore",
        "details.metrics[0]": "firstMetric",
      };

      ContextMapper.mergeChildResults(parentContext, childContext, outputMapping);

      // Verify mapped values
      expect((parentContext.variables.output as any).result).toBe("child-success");
      expect(parentContext.variables.status).toBe("completed");
      expect(parentContext.variables.finalScore).toBe(95);
      expect(parentContext.variables.firstMetric).toBe(10);

      // Verify parent data preserved
      expect(parentContext.variables.existingData).toBe("preserved");

      // Verify child data not bleeding through
      expect(parentContext.variables.result).toBeUndefined();
      expect(parentContext.variables.details).toBeUndefined();
    });

    test("should handle missing child variables gracefully", () => {
      const parentContext = ContextHelpers.createTestContext();
      const childContext = ContextHelpers.createTestContext("child", "child-exec", {
        existingVar: "value",
      });

      const outputMapping = {
        "nonexistent.path": "parentVar",
        existingVar: "mappedVar",
      };

      // Should not throw
      expect(() => {
        ContextMapper.mergeChildResults(parentContext, childContext, outputMapping);
      }).not.toThrow();

      expect(parentContext.variables.mappedVar).toBe("value");
      expect(parentContext.variables.parentVar).toBeUndefined();
    });

    test("should create intermediate objects when mapping to nested paths", () => {
      const parentContext = ContextHelpers.createTestContext();
      const childContext = ContextHelpers.createTestContext("child", "child-exec", {
        result: "success",
      });

      const outputMapping = {
        result: "output.nested.result",
      };

      ContextMapper.mergeChildResults(parentContext, childContext, outputMapping);

      expect((parentContext.variables.output as any).nested.result).toBe("success");
    });
  });

  describe("Mapping Validation", () => {
    const testContext = {
      userName: "John",
      user: { profile: { name: "John Doe" } },
      items: [{ value: 100 }],
    };

    test("should validate correct input mapping", () => {
      const mapping = {
        userName: "childUserName",
        "user.profile.name": "fullName",
        "items[0].value": "firstValue",
      };

      const result = ContextMapper.validateMapping(testContext, mapping, "input");

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("should detect invalid source paths", () => {
      // PathResolver returns undefined for missing paths but doesn't throw
      // Use a path that will actually throw an error
      const mapping = {
        "userName[0]": "childVar", // This will throw for array access on string
      };

      const result = ContextMapper.validateMapping(testContext, mapping, "input");

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Invalid input mapping");
      expect(result.errors[0]).toContain("Cannot index non-array value");
    });

    test("should detect invalid target keys", () => {
      const mapping = {
        userName: "", // Invalid empty target
        "user.profile.name": "validTarget",
      };

      const result = ContextMapper.validateMapping(testContext, mapping, "output");

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("Invalid target key");
    });

    test("should handle array indexing validation errors", () => {
      const mapping = {
        "userName[0]": "invalidArrayAccess", // userName is string, not array
      };

      const result = ContextMapper.validateMapping(testContext, mapping, "input");

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Cannot index non-array value");
    });
  });

  describe("Context Isolation Verification", () => {
    test("should maintain complete isolation between parent and child", () => {
      const parentContext = ContextHelpers.createTestContext("parent", "parent-exec", {
        shared: "parent-value",
        parentOnly: "parent-data",
      });

      const inputMapping = { shared: "sharedVar" };

      const childContext = ContextMapper.createChildContext(
        parentContext,
        inputMapping,
        "child-workflow",
        "child-exec",
      );

      // Modify child context
      childContext.variables.sharedVar = "modified-by-child";
      childContext.variables.childOnly = "child-data";

      // Verify parent context unchanged
      expect(parentContext.variables.shared).toBe("parent-value");
      expect(parentContext.variables.parentOnly).toBe("parent-data");
      expect(parentContext.variables.childOnly).toBeUndefined();

      // Verify child context has correct data
      expect(childContext.variables.sharedVar).toBe("modified-by-child");
      expect(childContext.variables.childOnly).toBe("child-data");
      expect(childContext.variables.parentOnly).toBeUndefined();
    });

    test("should not share object references between contexts", () => {
      const sharedObject = { value: "original" };
      const parentContext = ContextHelpers.createTestContext("parent", "parent-exec", {
        shared: sharedObject,
      });

      const inputMapping = { shared: "childShared" };

      const childContext = ContextMapper.createChildContext(
        parentContext,
        inputMapping,
        "child-workflow",
        "child-exec",
      );

      // Modify child's copy of the object
      (childContext.variables.childShared as any).value = "modified";

      // Verify parent's object unchanged (reference isolation)
      expect(sharedObject.value).toBe("original");
      expect((parentContext.variables.shared as any).value).toBe("original");
    });
  });

  describe("Complex Mapping Scenarios", () => {
    test("should handle deep object mapping", () => {
      const parentContext = ContextHelpers.createTestContext("parent", "parent-exec", {
        config: {
          database: {
            host: "localhost",
            credentials: {
              username: "admin",
              password: "secret",
            },
          },
          features: ["auth", "logging"],
        },
      });

      const inputMapping = {
        "config.database.host": "dbHost",
        "config.database.credentials.username": "dbUser",
        "config.features[0]": "primaryFeature",
      };

      const childContext = ContextMapper.createChildContext(
        parentContext,
        inputMapping,
        "child-workflow",
        "child-exec",
      );

      expect(childContext.variables.dbHost).toBe("localhost");
      expect(childContext.variables.dbUser).toBe("admin");
      expect(childContext.variables.primaryFeature).toBe("auth");
    });

    test("should handle complex output mapping with object creation", () => {
      const parentContext = ContextHelpers.createTestContext();
      const childContext = ContextHelpers.createTestContext("child", "child-exec", {
        success: true,
        data: {
          processed: 100,
          errors: [],
        },
        metrics: [95, 87, 92],
      });

      const outputMapping = {
        success: "result.success",
        "data.processed": "result.stats.processed",
        "data.errors": "result.stats.errors",
        "metrics[0]": "result.score",
      };

      ContextMapper.mergeChildResults(parentContext, childContext, outputMapping);

      expect((parentContext.variables.result as any).success).toBe(true);
      expect((parentContext.variables.result as any).stats.processed).toBe(100);
      expect((parentContext.variables.result as any).stats.errors).toEqual([]);
      expect((parentContext.variables.result as any).score).toBe(95);
    });
  });
});
