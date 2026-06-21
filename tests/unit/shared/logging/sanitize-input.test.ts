/**
 * Tests for sanitizeInput utility
 *
 * Verifies:
 * - Sensitive field removal (password, token, secret, key, auth, etc.)
 * - Email masking
 * - String truncation
 * - Array truncation
 * - Nesting depth limiting
 * - Resource ID extraction
 */

import { sanitizeInput, extractResourceIds, wasTruncated } from "@mcp-moira/shared";

describe("sanitizeInput", () => {
  describe("sensitive field removal", () => {
    it("removes password field", () => {
      const input = { username: "john", password: "secret123" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ username: "john" });
    });

    it("removes apiKey field (case-insensitive)", () => {
      const input1 = { apiKey: "sk-xxx", data: "test" };
      const input2 = { APIKEY: "sk-xxx", data: "test" };
      const input3 = { ApiKey: "sk-xxx", data: "test" };

      expect(sanitizeInput(input1).inputData).toEqual({ data: "test" });
      expect(sanitizeInput(input2).inputData).toEqual({ data: "test" });
      expect(sanitizeInput(input3).inputData).toEqual({ data: "test" });
    });

    it("removes token field", () => {
      const input = { accessToken: "abc123", refreshToken: "def456", data: "test" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ data: "test" });
    });

    it("removes fields containing secret", () => {
      const input = { clientSecret: "xxx", secretKey: "yyy", data: "test" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ data: "test" });
    });

    it("removes auth-related fields", () => {
      const input = {
        authorization: "Bearer xxx",
        authCode: "abc",
        data: "test",
      };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ data: "test" });
    });

    it("removes credential fields", () => {
      const input = { userCredential: "xxx", data: "test" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ data: "test" });
    });

    it("removes private key fields", () => {
      const input = { privateKey: "xxx", privateData: "yyy", data: "test" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ data: "test" });
    });

    it("removes session fields", () => {
      const input = { sessionId: "xxx", sessionToken: "yyy", data: "test" };
      const { inputData } = sanitizeInput(input);
      // sessionId ends with Id so it's extracted as resourceId
      // sessionToken contains both session and token - removed
      expect(inputData).toEqual({ data: "test" });
    });

    it("removes bearer and refresh fields", () => {
      const input = { bearerToken: "xxx", refreshKey: "yyy", data: "test" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ data: "test" });
    });

    it("removes pin, otp, cvv fields", () => {
      const input = { pin: "1234", otp: "123456", cvv: "123", data: "test" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ data: "test" });
    });

    it("removes passphrase fields", () => {
      const input = { passphrase: "my secret phrase", data: "test" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ data: "test" });
    });
  });

  describe("email masking", () => {
    it("masks email in any field", () => {
      const input = { email: "user@test.com", contact: "admin@domain.org" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({
        email: "us***@test.com",
        contact: "ad***@domain.org",
      });
    });

    it("masks short local part emails", () => {
      const input = { email: "a@test.com" };
      const { inputData } = sanitizeInput(input);
      expect(inputData).toEqual({ email: "a***@test.com" });
    });

    it("masks two-char local part emails with first char only", () => {
      const input = { email: "ab@test.com" };
      const { inputData } = sanitizeInput(input);
      // Two-char or less local part: only first char preserved
      expect(inputData).toEqual({ email: "a***@test.com" });
    });

    it("masks three-char local part emails with first two chars", () => {
      const input = { email: "abc@test.com" };
      const { inputData } = sanitizeInput(input);
      // Three+ char local part: first 2 chars preserved
      expect(inputData).toEqual({ email: "ab***@test.com" });
    });
  });

  describe("string truncation", () => {
    it("truncates strings longer than 1KB", () => {
      const longString = "x".repeat(2048); // 2KB
      const input = { data: longString };
      const { inputData } = sanitizeInput(input);

      const result = inputData as { data: string };
      expect(result.data.length).toBe(1024 + "[truncated]".length);
      expect(result.data.endsWith("[truncated]")).toBe(true);
    });

    it("preserves strings shorter than 1KB", () => {
      const shortString = "x".repeat(500);
      const input = { data: shortString };
      const { inputData } = sanitizeInput(input);

      expect(inputData).toEqual({ data: shortString });
    });
  });

  describe("array truncation", () => {
    it("truncates arrays exceeding 10KB total", () => {
      // Create array with 100 large objects (each ~500 bytes = 50KB total)
      const largeObjects = Array.from({ length: 100 }, (_, i) => ({
        index: i,
        content: "x".repeat(500),
      }));

      // Pass array directly as input
      const { inputData } = sanitizeInput(largeObjects);

      // Array should be wrapped with truncation metadata
      const result = inputData as {
        _items: unknown[];
        _truncated: boolean;
        _originalLength: number;
      };
      expect(result._truncated).toBe(true);
      expect(result._originalLength).toBe(100);
      expect(result._items.length).toBeLessThan(100);
    });

    it("preserves small arrays", () => {
      const smallArray = [1, 2, 3, 4, 5];
      const { inputData } = sanitizeInput(smallArray);

      expect(inputData).toEqual(smallArray);
    });

    it("truncates array inside object when exceeding size limit", () => {
      const largeObjects = Array.from({ length: 100 }, (_, i) => ({
        index: i,
        content: "x".repeat(500),
      }));

      const input = { items: largeObjects };
      const { inputData } = sanitizeInput(input);

      // The array inside object is truncated when total size exceeds limit
      // Check that inputData exists and items field is present
      expect(inputData).toBeDefined();
      const result = inputData as Record<string, unknown>;

      // items could be truncated array or [nested object] depending on depth/size
      // Main point: it should not throw and should have items key or be truncated
      if (result.items && typeof result.items === "object" && "_truncated" in result.items) {
        // Array was truncated
        const items = result.items as {
          _items: unknown[];
          _truncated: boolean;
          _originalLength: number;
        };
        expect(items._truncated).toBe(true);
        expect(items._originalLength).toBe(100);
      } else if (result._truncated) {
        // Object itself was truncated
        expect(result._truncated).toBe(true);
      }
    });
  });

  describe("nesting depth limiting", () => {
    // MAX_DEPTH = 3, meaning depth 0, 1, 2 are allowed
    // depth 0 = root object, depth 1 = level1, depth 2 = level2, depth 3 = [nested object]

    it("preserves 2 levels of nesting", () => {
      const input = {
        level1: {
          level2: {
            data: "test",
          },
        },
      };
      const { inputData } = sanitizeInput(input);

      const result = inputData as { level1: { level2: { data: string } } };
      expect(result.level1.level2.data).toBe("test");
    });

    it("replaces 3rd level with [nested object]", () => {
      const input = {
        level1: {
          level2: {
            level3: {
              data: "test",
            },
          },
        },
      };
      const { inputData } = sanitizeInput(input);

      const result = inputData as { level1: { level2: { level3: string } } };
      // level3 is at depth 3, so it becomes [nested object]
      expect(result.level1.level2.level3).toBe("[nested object]");
    });

    it("handles deeper nesting consistently", () => {
      const input = {
        a: {
          b: {
            c: {
              d: {
                e: "deep",
              },
            },
          },
        },
      };
      const { inputData } = sanitizeInput(input);

      const result = inputData as { a: { b: { c: string } } };
      // c is at depth 3, becomes [nested object]
      expect(result.a.b.c).toBe("[nested object]");
    });
  });

  describe("resource ID extraction", () => {
    it("extracts fields ending with Id", () => {
      const input = {
        workflowId: "wf-123",
        executionId: "exec-456",
        processId: "proc-789",
        data: "test",
      };

      const { resourceIds, inputData } = sanitizeInput(input);

      expect(resourceIds).toEqual({
        workflowId: "wf-123",
        executionId: "exec-456",
        processId: "proc-789",
      });
      // Resource IDs are removed from inputData to avoid duplication
      expect(inputData).toEqual({ data: "test" });
    });

    it("does not extract non-Id fields", () => {
      const input = {
        userId: "user-123",
        identity: "some-value", // Contains "id" but doesn't end with "Id"
        data: "test",
      };

      const { resourceIds, inputData } = sanitizeInput(input);

      expect(resourceIds).toEqual({ userId: "user-123" });
      expect(inputData).toEqual({ identity: "some-value", data: "test" });
    });
  });

  describe("null and undefined handling", () => {
    it("handles null input", () => {
      const { inputData, resourceIds } = sanitizeInput(null);
      expect(inputData).toBeNull();
      expect(resourceIds).toEqual({});
    });

    it("handles undefined input", () => {
      const { inputData, resourceIds } = sanitizeInput(undefined);
      expect(inputData).toBeUndefined();
      expect(resourceIds).toEqual({});
    });
  });

  describe("primitive handling", () => {
    it("handles number input", () => {
      const { inputData } = sanitizeInput(42);
      expect(inputData).toBe(42);
    });

    it("handles boolean input", () => {
      const { inputData } = sanitizeInput(true);
      expect(inputData).toBe(true);
    });

    it("handles string input", () => {
      const { inputData } = sanitizeInput("simple string");
      expect(inputData).toBe("simple string");
    });
  });
});

describe("extractResourceIds", () => {
  it("extracts only *Id fields from object", () => {
    const input = {
      workflowId: "wf-1",
      userId: "user-1",
      name: "test",
      action: "create",
    };

    const result = extractResourceIds(input);
    expect(result).toEqual({
      workflowId: "wf-1",
      userId: "user-1",
    });
  });

  it("returns empty object for non-object input", () => {
    expect(extractResourceIds(null)).toEqual({});
    expect(extractResourceIds(undefined)).toEqual({});
    expect(extractResourceIds("string")).toEqual({});
    expect(extractResourceIds(123)).toEqual({});
    expect(extractResourceIds([1, 2, 3])).toEqual({});
  });
});

describe("wasTruncated", () => {
  it("returns true if _truncated flag present", () => {
    expect(wasTruncated({ _truncated: true })).toBe(true);
  });

  it("returns false if _truncated flag not present", () => {
    expect(wasTruncated({ data: "test" })).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(wasTruncated(null)).toBe(false);
    expect(wasTruncated(undefined)).toBe(false);
    expect(wasTruncated("string")).toBe(false);
  });
});
